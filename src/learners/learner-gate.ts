// ────────────────────────────────────────
// Learner Concurrency Gate — thin insurance against runaway parallel
// extraction work. Combines an in-process Set (fast, single-process cap)
// with a Redis NX lock (multi-process safety across restarts/instances).
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

const LEARNER_MAX_CONCURRENT = 3; // tunable
const LEARNER_LOCK_TTL = 300; // seconds — tunable; stale-lock self-heal
const LEARNER_LOCK_PREFIX = 'xxb:learner:active:';

// In-process set of chatIds currently holding a slot.
const activeChats = new Set<number>();

function lockKey(chatId: number): string {
  return `${LEARNER_LOCK_PREFIX}${chatId}`;
}

/**
 * Try to acquire a learner slot for the given chat.
 * Fails (ok=false) if:
 *  - this chat already holds a slot in-process, or
 *  - the global in-process concurrency cap is reached, or
 *  - the Redis NX lock could not be taken (another process holds it).
 * On success the caller MUST call releaseLearnerSlot in a finally block.
 */
export async function acquireLearnerSlot(
  chatId: number,
): Promise<{ ok: boolean; reason?: string; active: number }> {
  if (activeChats.has(chatId)) {
    return { ok: false, reason: 'already_active', active: activeChats.size };
  }
  if (activeChats.size >= LEARNER_MAX_CONCURRENT) {
    return { ok: false, reason: 'global_cap', active: activeChats.size };
  }

  // Multi-process safety: SET key value NX EX ttl — returns 'OK' or null.
  let redisOk = false;
  try {
    const res = await getRedis().set(lockKey(chatId), '1', 'EX', LEARNER_LOCK_TTL, 'NX');
    redisOk = res === 'OK';
  } catch (err) {
    // Redis unavailable: fall back to in-process gate only rather than block
    // all learning. The in-process cap still provides single-process safety.
    logger.warn({ err, chatId }, 'learner-gate: redis lock failed, using in-process gate only');
    redisOk = true;
  }

  if (!redisOk) {
    return { ok: false, reason: 'redis_locked', active: activeChats.size };
  }

  activeChats.add(chatId);
  return { ok: true, active: activeChats.size };
}

/**
 * Release a previously-acquired slot. Idempotent: safe to call even if the
 * slot was never acquired (e.g. in a finally after a failed acquire).
 */
export async function releaseLearnerSlot(chatId: number): Promise<void> {
  activeChats.delete(chatId);
  try {
    await getRedis().del(lockKey(chatId));
  } catch (err) {
    logger.warn({ err, chatId }, 'learner-gate: redis unlock failed (lock will TTL out)');
  }
}
