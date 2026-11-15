// ────────────────────────────────────────
// Context 管理 — NyatDB ChatLog 主存 + 可选 Redis 镜像
// ────────────────────────────────────────
// 热路径（getRecent / addMessage）以 NyatDB 为准。
// Redis `xxb:ctx:*` 仅在 NYATDB_REDIS_MIRROR=true 或 NyatDB 未启用时写入。
// members / active_groups 等索引仍用 Redis（与 ChatLog 无关）。

import type { FormattedMessage } from '../../shared/types.js';
import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { unwrapPromptEnvelope, looksLikePromptEnvelope } from '../../shared/message-text.js';
import { unpackChatLogRow, getNyatDb, chatAppendFromFormatted } from '../../nyatdb/index.js';
import { filterRecalledOneBotMessages } from '../../platform/onebot-notices.js';
import type { ContextScope } from '../../context-engine/scope.js';
import { matchesContextScope } from '../../context-engine/scope.js';
import { bindContextMessage, contextRedisKey, contextStorageId, contextStorageKey, isMessageInContextScope, resolveStorageScope } from './storage-scope.js';

const CTX_PREFIX = 'xxb:ctx:';
const MEMBERS_PREFIX = 'xxb:members:';
const USER_GROUPS_PREFIX = 'xxb:user:groups:';
const USER_DMS_PREFIX = 'xxb:user:dms:';
const TRUNCATE_SIZE = 50;
const MEMBERS_TTL = 30 * 86400;
const CTX_TTL = 7 * 86400;

const RPUSH_TRIM_LUA = `
local key = KEYS[1]
redis.call('RPUSH', key, ARGV[1])
local len = redis.call('LLEN', key)
local maxLen = tonumber(ARGV[2])
local trimSize = tonumber(ARGV[3])
if len > maxLen then
  redis.call('LTRIM', key, len - maxLen, -1)
end
redis.call('EXPIRE', key, tonumber(ARGV[4]))
return len
`;

function legacyCtxKey(chatId: number, threadId?: number): string {
  // General topic (thread_id=1) is the default topic → plain key (backward compat).
  // Non-forum chats / undefined threadId → plain key.
  if (!threadId || threadId <= 1) return CTX_PREFIX + chatId;
  return `${CTX_PREFIX}${chatId}:t${threadId}`;
}

function nyatWriteEnabled(): boolean {
  const e = env();
  return e.NYATDB_ENABLED && e.NYATDB_DUAL_WRITE;
}

function redisCtxWriteEnabled(): boolean {
  const e = env();
  // NyatDB 主写且不镜像 → 不再写 Redis ctx
  if (nyatWriteEnabled() && !e.NYATDB_REDIS_MIRROR) return false;
  return true;
}

function sanitizeMessage(message: FormattedMessage): FormattedMessage {
  if (message.role !== 'user' || !message.textContent) return message;
  if (!looksLikePromptEnvelope(message.textContent)) return message;
  const inner = unwrapPromptEnvelope(message.textContent);
  if (!inner || inner === message.textContent) return message;
  logger.warn(
    {
      messageId: message.messageId,
      from: message.textContent.slice(0, 80),
      to: inner.slice(0, 80),
    },
    'Unwrapped prompt-envelope user text',
  );
  return { ...message, textContent: inner };
}

function appendToNyatDb(scope: ContextScope, message: FormattedMessage): void {
  const ndb = getNyatDb();
  if (!ndb) throw new Error('nyatdb_unavailable');
  if (!(message.messageId > 0)) {
    logger.debug({ chatId: scope.chatId }, 'skip NyatDB append (no messageId)');
    return;
  }
  const key = contextStorageId(scope, true);
  if (key === null) throw Error('context_storage_unavailable');
  ndb.chatAppend(key, chatAppendFromFormatted(message));
  const keep = env().NYATDB_MAX_MESSAGES_PER_CHAT;
  if (keep > 0 && message.messageId % 64 === 0) {
    ndb.chatTrimKeepLast(key, keep);
  }
}

async function appendToRedisCtx(scope: ContextScope, message: FormattedMessage): Promise<void> {
  const redis = getRedis();
  const maxLen = env().CONTEXT_MAX_LENGTH;
  await redis.eval(
    RPUSH_TRIM_LUA,
    1,
    contextRedisKey(scope),
    JSON.stringify(message),
    String(maxLen),
    String(maxLen - TRUNCATE_SIZE),
    String(CTX_TTL),
  );
}

export async function addMessage(chatId: number, message: FormattedMessage, threadId?: number): Promise<void> {
  message = sanitizeMessage(message);
  const bound = bindContextMessage(chatId, message, threadId);
  const scope = bound.scope;
  message = bound.message;
  threadId = scope.threadId;
  const cacheKey = contextStorageKey(scope);

  let nyatOk = false;
  if (nyatWriteEnabled()) {
    try {
      appendToNyatDb(scope, message);
      nyatOk = true;
    } catch (err) {
      logger.warn({ err, chatId, messageId: message.messageId }, 'NyatDB append failed');
    }
  }

  // Redis ctx: mirror, or primary fallback when NyatDB write failed / disabled
  if (redisCtxWriteEnabled() || !nyatOk) {
    try {
      await appendToRedisCtx(scope, message);
      // Redis moved ahead of NyatDB — allow catch-up on next getRecent
      if (!nyatOk) {
        catchUpSettled.delete(cacheKey);
        redisPeekSkip.delete(cacheKey);
      }
    } catch (err) {
      if (!nyatOk) throw err;
      logger.warn({ err, chatId }, 'Redis ctx mirror failed (NyatDB already wrote)');
    }
  } else if (nyatOk) {
    catchUpSettled.add(cacheKey);
  }

  const redis = getRedis();

  if (chatId < 0) {
    const ts = Math.floor(Date.now() / 1000);
    redis.zadd('xxb:active_groups', ts, String(chatId)).catch(() => {});
  }

  // Mid-term: Redis path when mirroring; NyatDB path when sole chat store.
  if (redisCtxWriteEnabled() || !nyatOk || (nyatOk && !env().NYATDB_REDIS_MIRROR)) {
    import('./mid-term.js')
      .then(({ maybeCompressMidTerm }) => maybeCompressMidTerm(chatId, threadId))
      .catch(() => {});
  }

  if (message.uid && message.role === 'user' && !message.isBot && !message.isAnonymous) {
    try {
      const memberKey = MEMBERS_PREFIX + chatId;
      const memberData = JSON.stringify({
        uid: message.uid,
        username: message.username,
        fullName: message.fullName,
        lastSeen: message.timestamp,
      });
      await redis.hset(memberKey, String(message.uid), memberData);
      await redis.expire(memberKey, MEMBERS_TTL);

      if (chatId < 0) {
        const userGroupsKey = USER_GROUPS_PREFIX + message.uid;
        await redis.sadd(userGroupsKey, String(chatId));
        await redis.expire(userGroupsKey, MEMBERS_TTL);
      } else if (chatId > 0) {
        const userDmsKey = USER_DMS_PREFIX + message.uid;
        await redis.sadd(userDmsKey, String(chatId));
        await redis.expire(userDmsKey, MEMBERS_TTL);
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Member tracking failed (non-critical)');
    }
  }
}

function safeParseMessages(raw: string[], scope: ContextScope): FormattedMessage[] {
  const result: FormattedMessage[] = [];
  for (const r of raw) {
    try {
      const message = JSON.parse(r) as FormattedMessage;
      if (isMessageInContextScope(message, scope)) result.push(message);
    } catch {
      logger.warn({ chatId: scope.chatId, threadId: scope.threadId }, 'Unverifiable context entry skipped');
    }
  }
  return result;
}

function fromNyatChatRows(
  rows: Array<{
    messageId: number;
    ts: number;
    uid: number;
    role: number;
    roleName: string;
    text: string;
    bodyFormat?: string;
  }>,
  scope: ContextScope,
): FormattedMessage[] {
  return rows.map((r) =>
    unpackChatLogRow({
      ...r,
      bodyFormat: r.bodyFormat === 'json' ? 'json' : r.bodyFormat === 'text' ? 'text' : undefined,
    }) as FormattedMessage,
  ).filter(message => isMessageInContextScope(message, scope));
}

/** Shared safe reader for recent context and mid-term compression. */
export function readScopedNyatContext(scope: ContextScope, count: number): FormattedMessage[] | null {
  if (!matchesContextScope(scope, resolveStorageScope(scope.chatId, scope.threadId))) return [];
  if (!env().NYATDB_ENABLED || !env().NYATDB_READ) return null;
  try {
    const ndb = getNyatDb();
    if (!ndb) return null;
    const key = contextStorageId(scope);
    const current = key === null ? [] : fromNyatChatRows(ndb.chatRecent(key, count), scope);
    // Never inspect or infer the old lossy topic-number buckets. Source-aware
    // non-topic rows can be read, but unknown old bodies stay untouched on disk.
    const legacy = scope.threadId === 0 ? fromNyatChatRows(ndb.chatRecent(scope.chatId, count), scope) : [];
    return mergeRecentWithRedis(current, legacy, count);
  } catch (err) {
    logger.warn({ err, chatId: scope.chatId }, 'NyatDB read failed; falling back to Redis');
    return null;
  }
}

async function readFromRedis(scope: ContextScope, count: number): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const [current, legacy] = await Promise.all([
    redis.lrange(contextRedisKey(scope), -count, -1),
    redis.lrange(legacyCtxKey(scope.chatId, scope.threadId), -count, -1),
  ]);
  // Legacy Redis keys are unambiguous strings, but their rows still need an
  // existing source identity. A current token is never used to relabel them.
  return mergeRecentWithRedis(safeParseMessages(current, scope), safeParseMessages(legacy, scope), count);
}

/** Lazy migrate Redis → NyatDB when NyatDB is empty but Redis still has history. */
function backfillNyatFromRedis(scope: ContextScope, msgs: FormattedMessage[]): void {
  if (!nyatWriteEnabled() || !msgs.length) return;
  try {
    const ndb = getNyatDb();
    if (!ndb) return;
    const nk = contextStorageId(scope, true);
    if (nk === null) return;
    const existing = ndb.chatRecent(nk, 1);
    if (existing.length) return;
    let n = 0;
    for (const m of msgs) {
      if (!isMessageInContextScope(m, scope)) continue;
      try {
        ndb.chatAppend(nk, chatAppendFromFormatted({ ...m, contextScope: scope }));
        n += 1;
      } catch {
        /* skip bad rows */
      }
    }
    if (n) logger.info({ chatId: scope.chatId, threadId: scope.threadId, n }, 'NyatDB backfilled from verified Redis ctx');
  } catch (err) {
    logger.warn({ err, chatId: scope.chatId }, 'NyatDB backfill failed');
  }
}

/** Chats whose Redis tip is known ≤ NyatDB tip (process-local). */
const catchUpSettled = new Set<string>();
/** Chats with no Redis-only holes in the ring — skip Redis LRANGE on getRecent. */
const redisPeekSkip = new Set<string>();

/** @internal vitest only */
export function _resetNyatCatchUpStateForTests(): void {
  catchUpSettled.clear();
  redisPeekSkip.clear();
}

/**
 * Catch up NyatDB when Redis has messages NyatDB lacks (tip-ahead OR mid-window holes
 * from the broken dual-write era). Uses chatRecent ring for membership — native chatGet
 * index can miss rows that are already in the ring.
 */
async function catchUpNyatFromRedis(scope: ContextScope): Promise<number> {
  const cacheKey = contextStorageKey(scope);
  if (!nyatWriteEnabled() || catchUpSettled.has(cacheKey)) return 0;
  try {
    const ndb = getNyatDb();
    if (!ndb) return 0;

    const fromRedis = await readFromRedis(scope, env().CONTEXT_MAX_LENGTH);
    if (!fromRedis.length) {
      catchUpSettled.add(cacheKey);
      return 0;
    }
    const nk = contextStorageId(scope, true);
    if (nk === null) return 0;
    const ringMax = Math.max(env().NYATDB_CHAT_RING_MAX || 0, env().CONTEXT_MAX_LENGTH);
    const current = fromNyatChatRows(ndb.chatRecent(nk, ringMax), scope);
    const known = new Set(current.map(r => r.messageId));
    const nyatLastId = current.at(-1)?.messageId ?? 0;

    // Only append Redis msgs that are newer than Nyat tip (safe for ring order).
    // Older holes are filled at read-time via mergeRecentWithRedis.
    let n = 0;
    for (const m of fromRedis) {
      if (!(m.messageId > nyatLastId)) continue;
      if (known.has(m.messageId)) continue;
      try {
        ndb.chatAppend(nk, chatAppendFromFormatted({ ...m, contextScope: scope }));
        known.add(m.messageId);
        n += 1;
      } catch {
        /* skip bad / duplicate rows */
      }
    }
    if (n) {
      logger.info({ chatId: scope.chatId, threadId: scope.threadId, n }, 'NyatDB catch-up from verified Redis ctx');
    }
    catchUpSettled.add(cacheKey);
    return n;
  } catch (err) {
    logger.warn({ err, chatId: scope.chatId }, 'NyatDB catch-up failed');
    return 0;
  }
}

/** Fill dual-write holes: union NyatDB + Redis by messageId (Nyat wins on conflict). */
function mergeRecentWithRedis(
  fromNyat: FormattedMessage[],
  fromRedis: FormattedMessage[],
  count: number,
): FormattedMessage[] {
  if (!fromRedis.length) return fromNyat.slice(-count);
  if (!fromNyat.length) return fromRedis.slice(-count);
  const byId = new Map<number, FormattedMessage>();
  for (const m of fromRedis) {
    if (m.messageId > 0) byId.set(m.messageId, m);
  }
  for (const m of fromNyat) {
    if (m.messageId > 0) byId.set(m.messageId, m);
  }
  const merged = [...byId.values()].sort(
    (a, b) => a.messageId - b.messageId || a.timestamp - b.timestamp,
  );
  return merged.slice(-count);
}

export async function getRecent(chatId: number, count: number, threadId?: number): Promise<FormattedMessage[]> {
  const scope = resolveStorageScope(chatId, threadId);
  if (!scope || !Number.isSafeInteger(count) || count <= 0) return [];
  const cacheKey = contextStorageKey(scope);
  // Configuration may be revoked while Redis awaits. Never return the previous
  // account's body to a caller whose current account binding has changed.
  const finish = (messages: FormattedMessage[]): FormattedMessage[] =>
    matchesContextScope(scope, resolveStorageScope(chatId, threadId))
      ? filterRecalledOneBotMessages(chatId, messages) : [];
  // Heal tip-ahead gaps before preferring NyatDB.
  if (nyatWriteEnabled() && env().NYATDB_READ) {
    await catchUpNyatFromRedis(scope);
  }

  const fromNyat = readScopedNyatContext(scope, count);

  // After catch-up + one clean merge, skip Redis LRANGE (hot path).
  if (
    fromNyat &&
    fromNyat.length > 0 &&
    redisPeekSkip.has(cacheKey) &&
    !env().NYATDB_REDIS_MIRROR
  ) {
    return finish(fromNyat.slice(-count));
  }

  // 取满 CONTEXT_MAX_LENGTH 只为给 mergeRecentWithRedis 补 NyatDB 空洞。NyatDB 读关闭时
  // 下面走的是 `fromRedis.slice(-count)`,多取的部分会被立刻丢掉 —— 而 getRecent 在一条
  // 产生回复的消息上被调用 8-10 次(judge 窗口/retriever/stale-reply×2/quote policy/
  // 判重/chat-style/chat-pressure),每次 LRANGE 600 条 + 600 次 JSON.parse ≈ 180KB,
  // 合计 ~1.4MB Redis 出向 + 40-80ms 同步阻塞。
  const needForMerge = nyatWriteEnabled() && env().NYATDB_READ;
  const fromRedis = await readFromRedis(
    scope,
    needForMerge ? Math.max(count, env().CONTEXT_MAX_LENGTH) : count,
  );

  if (fromNyat && fromNyat.length > 0) {
    const merged = mergeRecentWithRedis(fromNyat, fromRedis, count);
    if (!env().NYATDB_REDIS_MIRROR && catchUpSettled.has(cacheKey)) {
      const ringMax = Math.max(env().NYATDB_CHAT_RING_MAX || 0, env().CONTEXT_MAX_LENGTH);
      const ringIds = new Set(
        (readScopedNyatContext(scope, ringMax) ?? fromNyat).map((m) => m.messageId).filter((id) => id > 0),
      );
      const hasHole = fromRedis.some((m) => m.messageId > 0 && !ringIds.has(m.messageId));
      if (hasHole) redisPeekSkip.delete(cacheKey);
      else redisPeekSkip.add(cacheKey);
    }
    // Mirror off: keep legacy Redis hole copy alive until peek-skip settles.
    if (fromRedis.length > 0 && !env().NYATDB_REDIS_MIRROR && !redisPeekSkip.has(cacheKey)) {
      getRedis()
        .expire(contextRedisKey(scope), CTX_TTL)
        .catch(() => {});
    }
    return finish(merged);
  }

  if (fromRedis.length > 0) {
    backfillNyatFromRedis(scope, fromRedis);
    return finish(fromRedis.slice(-count));
  }
  return [];
}

export async function getAll(chatId: number, limit = 500, threadId?: number): Promise<FormattedMessage[]> {
  return getRecent(chatId, limit, threadId);
}

export async function addAssistant(
  chatId: number,
  reply: { textContent: string; messageId: number },
  threadId?: number,
): Promise<void> {
  // 2026-08-19：写 bot 真实身份——之前 uid:0/name:'' 在上下文里格式化成
  // 「Unknown(bot)」，bot 自己读回来认不出是自己说的（persona 约定是「名字+(bot)」）。
  let uid = 0;
  let username = '';
  let fullName = '';
  try {
    const { getBotIdentity } = await import('../../bot/bot.js');
    const id = getBotIdentity(chatId);
    uid = id.uid || 0;
    username = id.username || '';
    fullName = id.displayName || '';
  } catch {
    /* bot 未初始化（测试/关机路径）——保持匿名兜底 */
  }
  const assistantMsg: FormattedMessage = {
    role: 'assistant',
    uid,
    username,
    fullName,
    timestamp: Math.floor(Date.now() / 1000),
    messageId: reply.messageId,
    textContent: reply.textContent,
    isForwarded: false,
  };
  await addMessage(chatId, assistantMsg, threadId);
}

export interface GroupMember {
  uid: number;
  username: string;
  fullName: string;
  lastSeen: number;
}

/** Get all known members of a group (from message history) */
export async function getGroupMembers(chatId: number): Promise<GroupMember[]> {
  const redis = getRedis();
  const memberKey = MEMBERS_PREFIX + chatId;
  const all = await redis.hgetall(memberKey);
  const members: GroupMember[] = [];
  for (const val of Object.values(all)) {
    try {
      members.push(JSON.parse(val) as GroupMember);
    } catch {
      /* skip corrupted entries */
    }
  }
  members.sort((a, b) => b.lastSeen - a.lastSeen);
  return members;
}

export async function getUserGroups(uid: number): Promise<number[]> {
  const redis = getRedis();
  const members = await redis.smembers(USER_GROUPS_PREFIX + uid);
  return members.map(Number).filter((n) => Number.isFinite(n) && n < 0);
}

export async function getUserContexts(uid: number): Promise<number[]> {
  const redis = getRedis();
  const [groups, dms] = await Promise.all([
    redis.smembers(USER_GROUPS_PREFIX + uid),
    redis.smembers(USER_DMS_PREFIX + uid),
  ]);
  const out = new Set<number>();
  for (const g of groups) {
    const n = Number(g);
    if (Number.isFinite(n) && n < 0) out.add(n);
  }
  for (const d of dms) {
    const n = Number(d);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out];
}
