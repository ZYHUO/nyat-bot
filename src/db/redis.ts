import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    const isVitest = !!process.env['VITEST'];
    _redis = new Redis(env().REDIS_URL, {
      // BullMQ needs null; vitest CI has no Redis — finite retries or commands hang forever.
      maxRetriesPerRequest: isVitest ? 1 : null,
      connectTimeout: isVitest ? 150 : 10_000,
      enableReadyCheck: false,
      lazyConnect: true,
      ...(isVitest
        ? {
            retryStrategy: () => null,
            enableOfflineQueue: false,
          }
        : {}),
    });

    _redis.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });

    _redis.on('connect', () => {
      logger.info('Redis connected');
    });
  }
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = undefined;
  }
}
