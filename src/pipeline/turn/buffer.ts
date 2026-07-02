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
const KEY_TTL_SEC = 24 * 60 * 60;

// KEYS: [1]=pendingKey [2]=metaKey
// ARGV: [1]=entryJson [2]=nowMs [3]=ttlSec [4]=direct('1'/'0') [5]=messageId('0'=无)
const APPEND_PENDING_LUA = `
local count = redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('HSETNX', KEYS[2], 'firstPendingAt', ARGV[2])
redis.call('HSET', KEYS[2], 'lastMsgAt', ARGV[2])
if ARGV[4] == '1' then
  redis.call('HSET', KEYS[2], 'pendingDirect', '1')
end
local msgId = tonumber(ARGV[5])
if msgId and msgId > 0 then
  local hwm = tonumber(redis.call('HGET', KEYS[2], 'highWatermark') or '0')
  if msgId > hwm then
    redis.call('HSET', KEYS[2], 'highWatermark', ARGV[5])
  end
end
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return {count, redis.call('HGET', KEYS[2], 'firstPendingAt')}
`;

export async function appendPending(entry: PendingEntry): Promise<{ count: number; firstPendingAt: number }> {
  const redis = getRedis();
  const now = Date.now();
  const result = (await redis.eval(
    APPEND_PENDING_LUA,
    2,
    PENDING_KEY(entry.chatId),
    META_KEY(entry.chatId),
    JSON.stringify(entry),
    String(now),
    String(KEY_TTL_SEC),
    entry.direct ? '1' : '0',
    String(entry.messageId || 0),
  )) as [number, string | null];

  return { count: result[0] ?? 0, firstPendingAt: Number(result[1] ?? now) };
}

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

const WAIT_ANCHOR_KEY = (chatId: number) => `xxb:turn:waitanchor:${chatId}`;

export async function setWaitAnchor(chatId: number, entry: PendingEntry, ttlSec: number): Promise<void> {
  await getRedis().set(WAIT_ANCHOR_KEY(chatId), JSON.stringify(entry), 'EX', Math.max(ttlSec, 30));
}

export async function takeWaitAnchor(chatId: number): Promise<PendingEntry | null> {
  const redis = getRedis();
  const raw = await redis.getdel(WAIT_ANCHOR_KEY(chatId)).catch(async () => {
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

export async function hasPendingDirect(chatId: number): Promise<boolean> {
  const v = await getRedis().hget(META_KEY(chatId), 'pendingDirect');
  return v === '1';
}
