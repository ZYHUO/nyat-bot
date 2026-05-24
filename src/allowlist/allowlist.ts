import type { Redis } from 'ioredis';
import { randomBytes } from 'crypto';
import { logger } from '../shared/logger.js';
import type {
  AllowlistConfig,
  GroupRecord,
  PendingRequest,
  SubmitResult,
  SubmitParams,
} from './types.js';

export function isEnabled(config: AllowlistConfig): boolean {
  return config.enabled;
}

export async function isGroupAllowed(
  redis: Redis,
  config: AllowlistConfig,
  chatId: number,
): Promise<boolean> {
  if (!config.enabled) return true;
  // Try exact chatId first, then try without -100 prefix (miniapp may store short form)
  let raw = await redis.hget(`${config.redisPrefix}groups`, String(chatId));
  if (!raw && chatId < -1000000000000) {
    const shortId = String(chatId).replace(/^-100/, '');
    raw = await redis.hget(`${config.redisPrefix}groups`, shortId);
  }
  if (!raw) return false;
  try {
    const record = JSON.parse(raw) as GroupRecord;
    return record.approved && record.enabled;
  } catch {
    logger.warn({ chatId }, 'Corrupt group record in allowlist, denying access');
    return false;
  }
}

export async function getGroupRecord(
  redis: Redis,
  config: AllowlistConfig,
  chatId: number,
): Promise<GroupRecord | null> {
  const raw = await redis.hget(`${config.redisPrefix}groups`, String(chatId));
  return raw ? (JSON.parse(raw) as GroupRecord) : null;
}

export async function submit(
  redis: Redis,
  config: AllowlistConfig,
  params: SubmitParams,
): Promise<SubmitResult> {
  // 1. Rate limit
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rlKey = `${config.redisPrefix}rl:${params.userId}:${dateKey}`;
  const count = await redis.incr(rlKey);
  if (count === 1) await redis.expire(rlKey, 90000);
  if (count > config.maxSubmissionsPerUserPerDay) {
    return { ok: false, error: 'rate_limited' };
  }

  // 2. Already approved
  const existing = await redis.hget(
    `${config.redisPrefix}groups`,
    String(params.chatId),
  );
  if (existing) {
    return { ok: false, error: 'already_registered' };
  }

  // 3. Atomic dedup: try to acquire a per-chat pending lock
  const dedupKey = `${config.redisPrefix}submit_lock:${params.chatId}`;
  const lockAcquired = await redis.set(dedupKey, '1', 'EX', 300, 'NX');
  if (!lockAcquired) {
    // Check if it's actually pending or just a stale lock
    const allPending = await redis.hgetall(`${config.redisPrefix}pending`);
    for (const json of Object.values(allPending)) {
      const p = JSON.parse(json) as PendingRequest;
      if (p.chat_id === params.chatId) {
        return { ok: false, error: 'already_pending' };
      }
    }
    // Stale lock, clean up and retry once
    await redis.del(dedupKey);
    const retryLock = await redis.set(dedupKey, '1', 'EX', 300, 'NX');
    if (!retryLock) return { ok: false, error: 'already_pending' };
  }

  // Also scan pending to catch edge cases
  const allPending = await redis.hgetall(`${config.redisPrefix}pending`);
  for (const json of Object.values(allPending)) {
    const p = JSON.parse(json) as PendingRequest;
    if (p.chat_id === params.chatId) {
      await redis.del(dedupKey);
      return { ok: false, error: 'already_pending' };
    }
  }

  // 4. Create pending request
  const requestId = randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const request: PendingRequest = {
    request_id: requestId,
    chat_id: params.chatId,
    user_id: params.userId,
    username: params.username,
    first_name: params.firstName,
    last_name: params.lastName,
    note: params.note.slice(0, 500),
    chat_title: params.chatTitle,
    created_at: now,
    ai_reason: '',
    review_state: 'needs_manual',
  };

  await redis.hset(
    `${config.redisPrefix}pending`,
    requestId,
    JSON.stringify(request),
  );

  logger.info({ requestId, chatId: params.chatId }, 'Allowlist request submitted');
  return { ok: true, request_id: requestId };
}

export async function listPending(
  redis: Redis,
  config: AllowlistConfig,
): Promise<PendingRequest[]> {
  const all = await redis.hgetall(`${config.redisPrefix}pending`);
  return Object.values(all).map((json) => JSON.parse(json) as PendingRequest);
}

export async function listManualQueue(
  redis: Redis,
  config: AllowlistConfig,
): Promise<PendingRequest[]> {
  const all = await listPending(redis, config);
  return all.filter((r) => r.review_state === 'needs_manual');
}

export async function listGroups(
  redis: Redis,
  config: AllowlistConfig,
): Promise<GroupRecord[]> {
  const all = await redis.hgetall(`${config.redisPrefix}groups`);
  return Object.values(all).map((json) => JSON.parse(json) as GroupRecord);
}

export async function listByUser(
  redis: Redis,
  config: AllowlistConfig,
  userId: number,
): Promise<{
  pending: PendingRequest[];
  reviewed: PendingRequest[];
  groups: GroupRecord[];
}> {
  const pending = (await listPending(redis, config)).filter(
    (r) => r.user_id === userId,
  );
  const reviewed = Object.values(
    await redis.hgetall(`${config.redisPrefix}reviewed`),
  )
    .map((json) => JSON.parse(json) as PendingRequest)
    .filter((r) => r.user_id === userId);
  const groups = (await listGroups(redis, config)).filter(
    (g) => g.submitter_user_id === userId,
  );
  return { pending, reviewed, groups };
}

export async function approveRequest(
  redis: Redis,
  config: AllowlistConfig,
  requestId: string,
  approvedBy: string,
  enableNow?: boolean,
): Promise<{ ok: boolean; chat_id?: number; enabled?: boolean }> {
  const raw = await redis.hget(`${config.redisPrefix}pending`, requestId);
  if (!raw) return { ok: false };
  const request = JSON.parse(raw) as PendingRequest;

  const shouldEnable = enableNow ?? config.defaultEnabledAfterApproval;
  const now = Math.floor(Date.now() / 1000);

  const group: GroupRecord = {
    chat_id: request.chat_id,
    approved: true,
    enabled: shouldEnable,
    approved_by: approvedBy,
    approved_at: now,
    title: request.chat_title,
    last_request_id: requestId,
    submitter_user_id: request.user_id,
    submitter_username: request.username,
    submitter_first_name: request.first_name,
    submitter_last_name: request.last_name,
    review_state: approvedBy === 'ai' ? 'auto_approved' : 'manual_approved',
    ai_decision: request.ai_decision,
    ai_confidence: request.ai_confidence,
    ai_reason: request.ai_reason,
    ai_reviewed_at: request.ai_reviewed_at,
    updated_at: now,
  };

  await redis.hset(
    `${config.redisPrefix}groups`,
    String(request.chat_id),
    JSON.stringify(group),
  );
  await redis.hdel(`${config.redisPrefix}pending`, requestId);

  logger.info({ requestId, chatId: request.chat_id, approvedBy }, 'Allowlist request approved');
  return { ok: true, chat_id: request.chat_id, enabled: shouldEnable };
}

export async function rejectRequest(
  redis: Redis,
  config: AllowlistConfig,
  requestId: string,
): Promise<boolean> {
  const raw = await redis.hget(`${config.redisPrefix}pending`, requestId);
  if (!raw) return false;
  await redis.hset(`${config.redisPrefix}reviewed`, requestId, raw);
  await redis.hdel(`${config.redisPrefix}pending`, requestId);

  logger.info({ requestId }, 'Allowlist request rejected');
  return true;
}

export async function setGroupEnabled(
  redis: Redis,
  config: AllowlistConfig,
  chatId: number,
  enabled: boolean,
): Promise<boolean> {
  const raw = await redis.hget(`${config.redisPrefix}groups`, String(chatId));
  if (!raw) return false;
  const group = JSON.parse(raw) as GroupRecord;
  group.enabled = enabled;
  group.updated_at = Math.floor(Date.now() / 1000);
  await redis.hset(
    `${config.redisPrefix}groups`,
    String(chatId),
    JSON.stringify(group),
  );
  return true;
}

export async function removeGroup(
  redis: Redis,
  config: AllowlistConfig,
  chatId: number,
): Promise<boolean> {
  const deleted = await redis.hdel(`${config.redisPrefix}groups`, String(chatId));
  return deleted > 0;
}

const REVIEWED_MAX_AGE_SECONDS = 30 * 86400; // 30 days

/** Prune reviewed entries older than 30 days to prevent unbounded growth */
export async function pruneReviewed(
  redis: Redis,
  config: AllowlistConfig,
): Promise<number> {
  const all = await redis.hgetall(`${config.redisPrefix}reviewed`);
  const cutoff = Math.floor(Date.now() / 1000) - REVIEWED_MAX_AGE_SECONDS;
  const toDelete: string[] = [];

  for (const [key, json] of Object.entries(all)) {
    try {
      const entry = JSON.parse(json) as PendingRequest;
      if (entry.created_at < cutoff) {
        toDelete.push(key);
      }
    } catch {
      toDelete.push(key); // corrupt entry, remove
    }
  }

  if (toDelete.length > 0) {
    await redis.hdel(`${config.redisPrefix}reviewed`, ...toDelete);
    logger.info({ count: toDelete.length }, 'Pruned old reviewed entries');
  }
  return toDelete.length;
}
