// ────────────────────────────────────────
// Context 管理 (Redis)
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';
import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const CTX_PREFIX = 'xxb:ctx:';
const MEMBERS_PREFIX = 'xxb:members:';
const USER_GROUPS_PREFIX = 'xxb:user:groups:';
const TRUNCATE_SIZE = 50;
const MEMBERS_TTL = 30 * 86400; // 30 days
const CTX_TTL = 7 * 86400; // 7 days rolling TTL

// Atomic rpush + trim + expire via Lua
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

function ctxKey(chatId: number): string {
  return CTX_PREFIX + chatId;
}

export async function addMessage(chatId: number, message: FormattedMessage): Promise<void> {
  const redis = getRedis();
  const maxLen = env().CONTEXT_MAX_LENGTH;
  await redis.eval(
    RPUSH_TRIM_LUA,
    1,
    ctxKey(chatId),
    JSON.stringify(message),
    String(maxLen),
    String(maxLen - TRUNCATE_SIZE),
    String(CTX_TTL),
  );

  // Track active group chats for idle discovery (sorted set: score = last seen timestamp)
  if (chatId < 0) {
    const ts = Math.floor(Date.now() / 1000);
    redis.zadd('xxb:active_groups', ts, String(chatId)).catch(() => {});
  }

  // Track group member (skip bots and assistant messages)
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

      // Reverse index: track which groups this user belongs to
      if (chatId < 0) {
        const userGroupsKey = USER_GROUPS_PREFIX + message.uid;
        await redis.sadd(userGroupsKey, String(chatId));
        await redis.expire(userGroupsKey, MEMBERS_TTL);
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Member tracking failed (non-critical)');
    }
  }
}

function safeParseMessages(raw: string[]): FormattedMessage[] {
  const result: FormattedMessage[] = [];
  for (const r of raw) {
    try {
      result.push(JSON.parse(r) as FormattedMessage);
    } catch {
      logger.warn({ snippet: r.slice(0, 80) }, 'Corrupted context entry skipped');
    }
  }
  return result;
}

export async function getRecent(chatId: number, count: number): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(ctxKey(chatId), -count, -1);
  return safeParseMessages(raw);
}

export async function getAll(chatId: number, limit = 500): Promise<FormattedMessage[]> {
  const redis = getRedis();
  const raw = await redis.lrange(ctxKey(chatId), -limit, -1);
  return safeParseMessages(raw);
}

export async function addAssistant(chatId: number, reply: { textContent: string; messageId: number }): Promise<void> {
  const assistantMsg: FormattedMessage = {
    role: 'assistant',
    uid: 0,
    username: '',
    fullName: '',
    timestamp: Math.floor(Date.now() / 1000),
    messageId: reply.messageId,
    textContent: reply.textContent,
    isForwarded: false,
  };
  await addMessage(chatId, assistantMsg);
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
    } catch { /* skip corrupted entries */ }
  }
  // Sort by last seen (most recent first)
  members.sort((a, b) => b.lastSeen - a.lastSeen);
  return members;
}

/** Get all group chatIds a user has been seen in (reverse index) */
export async function getUserGroups(uid: number): Promise<number[]> {
  const redis = getRedis();
  const raw = await redis.smembers(USER_GROUPS_PREFIX + uid);
  return raw.map(Number).filter((n) => !Number.isNaN(n));
}
