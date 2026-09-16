// ────────────────────────────────────────
// Per-user 频率限制中间件
// ────────────────────────────────────────

import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../env.js';

const RL_PREFIX = 'xxb:rl:';
const RL_WINDOW = 60; // 1 minute window

// Atomic INCR + EXPIRE via Lua (prevents orphan keys on crash)
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local count = redis.call('INCR', key)
if count == 1 then
  redis.call('EXPIRE', key, tonumber(ARGV[1]))
end
return count
`;

export async function isRateLimited(userId: number): Promise<boolean> {
  const redis = getRedis();
  const key = `${RL_PREFIX}${userId}`;
  const limit = env().RATE_LIMIT_PER_MIN;

  const count = (await redis.eval(RATE_LIMIT_LUA, 1, key, String(RL_WINDOW))) as number;

  if (count > limit) {
    logger.warn({ userId, count, limit }, 'User rate limited');
    return true;
  }

  return false;
}
