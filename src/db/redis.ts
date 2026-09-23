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

/**
 * round 64（新 goal，用户："各部分在不在正常工作"）：closeRedis 可能永久挂住。
 *
 * 实测：45 次 `Forced exit after shutdown timeout`（跨 09-18..09-23 六天），
 * shutdown step 最后打在 `redis+db` —— 即卡在 closeRedis()。
 *
 * 病因是 ioredis 的已知行为：`quit()` 会发 QUIT 然后**等回复**，
 * 而连接若已断开/正在重连，那个回复永不到来，Promise 永不 resolve。
 * 表现就是优雅关闭永远走不完，最后被 25s 强杀（丢 WAL checkpoint /
 * token 记账 / BullMQ 锁释放）。
 *
 * 修法：race 一个 3s 超时，超时就用 `disconnect()` 硬断（不发 QUIT 也认）。
 * 3s 的理由：正常 quit 是毫秒级；连 3s 都等不到说明连接已经不对了，
 * 再等也不会有结果，而 systemd 只给 30s。
 */
const REDIS_QUIT_TIMEOUT_MS = 3_000;

export async function closeRedis(): Promise<void> {
  if (!_redis) return;
  const client = _redis;
  _redis = undefined;                       // 先置空，重入/并发 close 不再碰它
  try {
    await Promise.race([
      client.quit(),
      new Promise<void>((resolve) => setTimeout(resolve, REDIS_QUIT_TIMEOUT_MS).unref()),
    ]);
  } catch {
    /* quit 抛错（连接已断）就当已关 */
  } finally {
    try {
      // 超时分支走这里：不等 QUIT 回复，直接断 socket。
      if (client.status !== 'end') client.disconnect();
    } catch {
      /* ignore */
    }
  }
}
