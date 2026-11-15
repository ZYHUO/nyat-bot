import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export type AiWorkload = 'interactive' | 'background';
const workloadStorage = new AsyncLocalStorage<AiWorkload>();

/** Inherited by the actual asynchronous task, not merely its scheduler. */
export function runWithAiWorkload<T>(workload: AiWorkload, fn: () => T): T {
  return workloadStorage.run(workload, fn);
}

export function getAiWorkload(): AiWorkload {
  return workloadStorage.getStore() ?? 'interactive';
}

export interface AiInFlightLease {
  release(): Promise<void>;
}

interface LeaseOptions {
  model: string;
  workload: AiWorkload;
  totalLimit: number;
  backgroundLimit: number;
  timeoutMs: number;
}

// Includes abort/transport cleanup after the provider's effective timeout.
const LEASE_GRACE_MS = 30_000;

export function aiLeaseKeys(model: string): [string, string] {
  // Both keys share a Redis Cluster slot; arbitrary model names cannot inject braces.
  const slot = createHash('sha256').update(model).digest('hex');
  return [`xxb:ai:leases:{${slot}}:all`, `xxb:ai:leases:{${slot}}:background`];
}

const ACQUIRE_LEASE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
if ARGV[4] == 'background' and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
local expires = now + tonumber(ARGV[5])
redis.call('ZADD', KEYS[1], expires, ARGV[1])
if ARGV[4] == 'background' then redis.call('ZADD', KEYS[2], expires, ARGV[1]) end
-- A shorter new request must not truncate an older, longer request's lease.
for _, key in ipairs(KEYS) do
  local last = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if #last > 0 then redis.call('PEXPIRE', key, math.max(1, tonumber(last[2]) - now)) end
end
return 1
`;

const RELEASE_LEASE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Atomic total/background admission. Active background work is never preempted.
 * At least one total slot is reserved for interactive work (totalLimit=1 disables
 * background admission). Redis failures propagate: the caller chooses fail-closed.
 * A late release removes only its token, even after expiry and replacement.
 */
export async function acquireAiLease(
  redis: Pick<Redis, 'eval'>,
  options: LeaseOptions,
): Promise<AiInFlightLease | null> {
  if (!Number.isSafeInteger(options.totalLimit) || options.totalLimit < 1
    || !Number.isSafeInteger(options.backgroundLimit) || options.backgroundLimit < 0
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
    || options.timeoutMs > 2_147_483_647) {
    throw new RangeError('Invalid AI workload lease limits or timeout');
  }
  const keys = aiLeaseKeys(options.model);
  const token = randomUUID();
  const backgroundLimit = Math.min(options.backgroundLimit, options.totalLimit - 1);
  const admitted = await redis.eval(ACQUIRE_LEASE, 2, ...keys, token,
    options.totalLimit, backgroundLimit, options.workload, options.timeoutMs + LEASE_GRACE_MS);
  if (admitted !== 1) return null;
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Exact token removal cannot release someone else's slot after expiry.
      await redis.eval(RELEASE_LEASE, 2, ...keys, token);
    },
  };
}
