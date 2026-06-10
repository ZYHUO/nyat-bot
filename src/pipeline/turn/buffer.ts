// ────────────────────────────────────────
// Turn Actor — Redis pending 缓冲 + 回合元数据
// ────────────────────────────────────────
//
// actor 模式下 ingress 不再每条消息一个 job,而是:
//   appendPending() 写入 xxb:turn:pending:{chatId} → scheduleTurn() 排程回合。
// 回合开火时 drainPending() 原子取走整个 burst 作为决策单元(G4 的地基)。
//
// 元数据 hash xxb:turn:meta:{chatId}:
//   scheduledJobId / firstPendingAt / lastMsgAt / highWatermark / epoch / dirty

import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import type { PendingEntry, TurnMeta } from './types.js';

const PENDING_KEY = (chatId: number) => `xxb:turn:pending:${chatId}`;
const META_KEY = (chatId: number) => `xxb:turn:meta:${chatId}`;

/** pending/meta TTL:防止已退群/死群的缓冲永久残留 */
const KEY_TTL_SEC = 24 * 60 * 60;

/**
 * Append one inbound update to the chat's pending buffer.
 * Returns the new buffer length and the (possibly just-set) firstPendingAt.
 */
export async function appendPending(entry: PendingEntry): Promise<{ count: number; firstPendingAt: number }> {
  const redis = getRedis();
  const now = Date.now();
  const pendingKey = PENDING_KEY(entry.chatId);
  const metaKey = META_KEY(entry.chatId);

  const multi = redis.multi();
  multi.rpush(pendingKey, JSON.stringify(entry));
  multi.expire(pendingKey, KEY_TTL_SEC);
  multi.hsetnx(metaKey, 'firstPendingAt', String(now));
  multi.hset(metaKey, 'lastMsgAt', String(now));
  // P1 修复:direct 位持久化 —— 回合活跃期间到达的 @/回复 bot 走
  // markDirty 路径会丢失 direct 性,收尾再排程时被罚整整一个去抖窗口。
  if (entry.direct) multi.hset(metaKey, 'pendingDirect', '1');
  multi.expire(metaKey, KEY_TTL_SEC);
  const results = await multi.exec();
  const count = (results?.[0]?.[1] as number) ?? 0;

  // High-watermark: keep max messageId seen (read-modify-write; single
  // process + per-chat low contention makes this race acceptable).
  if (entry.messageId) {
    const hwm = Number((await redis.hget(metaKey, 'highWatermark')) ?? '0');
    if (entry.messageId > hwm) {
      await redis.hset(metaKey, 'highWatermark', String(entry.messageId));
    }
  }

  const firstRaw = await redis.hget(metaKey, 'firstPendingAt');
  return { count, firstPendingAt: Number(firstRaw ?? now) };
}

/**
 * Atomically take the entire pending burst (and reset the debounce anchor).
 * Malformed entries are dropped with a warning.
 */
export async function drainPending(chatId: number): Promise<PendingEntry[]> {
  const redis = getRedis();
  const pendingKey = PENDING_KEY(chatId);
  const metaKey = META_KEY(chatId);

  const multi = redis.multi();
  multi.lrange(pendingKey, 0, -1);
  multi.del(pendingKey);
  multi.hdel(metaKey, 'firstPendingAt', 'pendingDirect');
  const results = await multi.exec();
  const raw = (results?.[0]?.[1] as string[]) ?? [];

  const entries: PendingEntry[] = [];
  for (const item of raw) {
    try {
      entries.push(JSON.parse(item) as PendingEntry);
    } catch (err) {
      logger.warn({ err, chatId }, 'Dropping malformed pending entry');
    }
  }
  return entries;
}

export async function pendingCount(chatId: number): Promise<number> {
  return getRedis().llen(PENDING_KEY(chatId));
}

export async function getTurnMeta(chatId: number): Promise<TurnMeta> {
  const raw = await getRedis().hgetall(META_KEY(chatId));
  return {
    scheduledJobId: raw['scheduledJobId'] || undefined,
    firstPendingAt: raw['firstPendingAt'] ? Number(raw['firstPendingAt']) : undefined,
    lastMsgAt: raw['lastMsgAt'] ? Number(raw['lastMsgAt']) : undefined,
    highWatermark: raw['highWatermark'] ? Number(raw['highWatermark']) : undefined,
    epoch: raw['epoch'] ? Number(raw['epoch']) : undefined,
    dirty: raw['dirty'] === '1',
  };
}

export async function setScheduledJob(chatId: number, jobId: string): Promise<void> {
  const redis = getRedis();
  await redis.hset(META_KEY(chatId), 'scheduledJobId', jobId);
  await redis.expire(META_KEY(chatId), KEY_TTL_SEC);
}

/** Clear scheduledJobId, but only if it still points at `jobId` (avoid clobbering a newer schedule). */
export async function clearScheduledJob(chatId: number, jobId?: string): Promise<void> {
  const redis = getRedis();
  if (jobId) {
    const current = await redis.hget(META_KEY(chatId), 'scheduledJobId');
    if (current && current !== jobId) return;
  }
  await redis.hdel(META_KEY(chatId), 'scheduledJobId');
}

export async function markDirty(chatId: number): Promise<void> {
  await getRedis().hset(META_KEY(chatId), 'dirty', '1');
}

export async function clearDirty(chatId: number): Promise<boolean> {
  const removed = await getRedis().hdel(META_KEY(chatId), 'dirty');
  return removed > 0;
}

/** Bump the turn epoch (new cognition turn starting). Returns the new epoch. */
export async function bumpEpoch(chatId: number): Promise<number> {
  const redis = getRedis();
  const epoch = await redis.hincrby(META_KEY(chatId), 'epoch', 1);
  await redis.expire(META_KEY(chatId), KEY_TTL_SEC);
  return epoch;
}

export async function getHighWatermark(chatId: number): Promise<number> {
  const raw = await getRedis().hget(META_KEY(chatId), 'highWatermark');
  return Number(raw ?? '0');
}

export async function getLastMsgAt(chatId: number): Promise<number | undefined> {
  const raw = await getRedis().hget(META_KEY(chatId), 'lastMsgAt');
  return raw ? Number(raw) : undefined;
}

// ── G5: wait 锚点暂存 ───────────────────────────────────────────────
// gate=wait 时把触发条目(原始 update)存起来;wait 到期后重注入 pending,
// 让回合带着完整语境重新决策——"等一下再回"终于真的会回。

const WAIT_ANCHOR_KEY = (chatId: number) => `xxb:turn:waitanchor:${chatId}`;

export async function setWaitAnchor(chatId: number, entry: PendingEntry, ttlSec: number): Promise<void> {
  await getRedis().set(WAIT_ANCHOR_KEY(chatId), JSON.stringify(entry), 'EX', Math.max(ttlSec, 30));
}

/** Atomically fetch-and-delete the stashed wait anchor (GETDEL). */
export async function takeWaitAnchor(chatId: number): Promise<PendingEntry | null> {
  const redis = getRedis();
  const raw = await redis.getdel(WAIT_ANCHOR_KEY(chatId)).catch(async () => {
    // Redis < 6.2 fallback
    const v = await redis.get(WAIT_ANCHOR_KEY(chatId));
    if (v) await redis.del(WAIT_ANCHOR_KEY(chatId));
    return v;
  });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingEntry;
  } catch (err) {
    logger.warn({ err, chatId }, 'Malformed wait anchor, dropping');
    return null;
  }
}

/** 缓冲中是否有 direct 条目(回合收尾再排程时恢复即时开火用) */
export async function hasPendingDirect(chatId: number): Promise<boolean> {
  const v = await getRedis().hget(META_KEY(chatId), 'pendingDirect');
  return v === '1';
}
