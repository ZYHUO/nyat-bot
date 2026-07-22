/**
 * Default Redis stub so CI (no Redis) never hangs on ioredis
 * maxRetriesPerRequest:null. Suites that need richer behavior still
 * vi.mock('../../src/db/redis.js') themselves (file mocks win).
 */
import { vi } from 'vitest';

function chainable() {
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const m of [
    'get',
    'set',
    'del',
    'exists',
    'expire',
    'incr',
    'decr',
    'lpush',
    'rpush',
    'lrange',
    'ltrim',
    'llen',
    'lpop',
    'rpop',
    'sadd',
    'srem',
    'smembers',
    'sismember',
    'zadd',
    'zrange',
    'zrem',
    'zcard',
    'hget',
    'hset',
    'hdel',
    'hgetall',
    'publish',
    'subscribe',
    'eval',
    'call',
  ]) {
    api[m] = vi.fn(async () => (m === 'set' ? 'OK' : m.startsWith('l') || m.startsWith('s') || m.startsWith('z') ? [] : null));
  }
  api['multi'] = () => {
    const ops: Array<() => void> = [];
    const m: Record<string, unknown> = {};
    for (const name of ['lpush', 'rpush', 'ltrim', 'del', 'sadd', 'srem', 'expire', 'set', 'zadd']) {
      m[name] = () => {
        ops.push(() => undefined);
        return m;
      };
    }
    m['exec'] = async () => [];
    return m;
  };
  api['on'] = () => self();
  api['connect'] = async () => undefined;
  api['quit'] = async () => undefined;
  api['disconnect'] = () => undefined;
  return api;
}

vi.mock('../src/db/redis.js', () => ({
  getRedis: () => chainable(),
  closeRedis: async () => undefined,
}));
