// ────────────────────────────────────────
// Per-chat critical-section lock (Redis NX + owner token)
// ────────────────────────────────────────
//
// Used for short per-chat critical sections where ordering matters.
// The pipeline acquires it around intake/judge and again around send/finalize.
//
// Lock TTL is a safety net — if the process crashes mid-pipeline the lock
// expires automatically so the next message isn't blocked forever.
// Release only deletes if the token matches (prevents deleting another holder's lock).
// If we cannot acquire within MAX_WAIT_MS, we proceed without holding the lock (fail-open).

import { nanoid } from "nanoid";
import { getRedis } from "../db/redis.js";
import { logger } from "../shared/logger.js";

const LOCK_TTL_MS = 300_000; // 5 min — pipeline (judge + AI) can exceed 60s
const POLL_INTERVAL_MS = 100; // how often to retry acquiring the lock
const MAX_WAIT_MS = 120_000; // give up after 2 minutes waiting

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

function lockKey(chatId: number): string {
  return `xxb:chat:lock:${chatId}`;
}

/**
 * Acquire the per-chat lock. Waits (polling) until acquired or timeout.
 * Returns a release function. Always call release() in a finally block.
 * On wait timeout, returns a no-op release and processing continues without the lock.
 */
export async function acquireChatLock(
  chatId: number,
): Promise<() => Promise<void>> {
  const redis = getRedis();
  const key = lockKey(chatId);
  const waited = { ms: 0 };

  while (true) {
    const token = nanoid();
    // ioredis: SET key value PX ms NX
    const result = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
    if (result === "OK") {
      if (waited.ms > 0) {
        logger.debug(
          { chatId, waitedMs: waited.ms },
          "Chat lock acquired after wait",
        );
      }
      return async () => {
        try {
          await redis.eval(RELEASE_LOCK_LUA, 1, key, token);
        } catch (err) {
          logger.debug(
            { chatId, err },
            "Chat lock release failed (non-critical)",
          );
        }
      };
    }

    if (waited.ms >= MAX_WAIT_MS) {
      logger.warn(
        { chatId, waitedMs: waited.ms },
        "Chat lock wait timeout — proceeding without lock (ordering vs other workers not guaranteed)",
      );
      // No-op release: we never acquired NX, so nothing to delete — pipeline continues.
      return async () => {};
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    waited.ms += POLL_INTERVAL_MS;
  }
}
