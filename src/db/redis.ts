import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    const isVitest = !!process.env['VITEST'];
    // vitest 进程经 dotenv 拿到生产 .env 的 REDIS_URL(db 5)——漏 mock 的测试会直接
    // 读写生产数据（2026-08-21 事故：bot-flow 测试的 addAssistant 把「好群」fixture
    // 写进主人 DM 上下文，bot 当真事复述）。测试一律强制 db 0。
    const rawUrl = env().REDIS_URL;
    const url = isVitest ? rawUrl.replace(/\/\d+$/, '/0') : rawUrl;
    _redis = new Redis(url, {
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
