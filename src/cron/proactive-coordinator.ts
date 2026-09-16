// ────────────────────────────────────────
// P2-A: 主动搭话统一调度器
// ────────────────────────────────────────
//
// 问题：idle + proactive-scan 两套 cron 独立运行，
// 可能同一时间对同一群各发一条 → bot 刷屏。
//
// 解决：
// 1. 短期锁（60s TTL）：任一系统发了消息，60s 内另一个系统跳过
// 2. 每群每小时计数：超过 PROACTIVE_HOURLY_MAX_PER_CHAT 则跳过
//
// 用法：在 idle.ts / proactive-scan.ts 发消息前调用 tryAcquire，
// 发送后调用 markSent。

import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const LOCK_PREFIX = 'xxb:proactive:lock:';     // 短期锁，60s TTL
const HOUR_PREFIX = 'xxb:proactive:hour:';     // 每小时计数
const LOCK_TTL_SEC = 60;

/**
 * 尝试获取主动发言配额。
 * 返回 true = 可以发，false = 被限流跳过。
 */
export async function tryAcquireProactiveSlot(
  chatId: number,
  source: string,
): Promise<boolean> {
  if (!env().PROACTIVE_COORDINATOR_ENABLED) return true;

  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);

  // 1. 短期锁 — 防止 idle 和 proactive-scan 同窗口双发
  const lockKey = LOCK_PREFIX + chatId;
  const acquired = await redis.set(lockKey, source, 'EX', LOCK_TTL_SEC, 'NX');
  if (acquired !== 'OK') {
    logger.debug({ chatId, source }, 'Proactive coordinator: lock held, skipping');
    return false;
  }

  // 2. 每小时计数 — 全局 rate limit
  const hourKey = `${HOUR_PREFIX}${chatId}:${Math.floor(now / 3600)}`;
  const count = await redis.incr(hourKey);
  if (count === 1) await redis.expire(hourKey, 3600);

  const maxPerHour = env().PROACTIVE_HOURLY_MAX_PER_CHAT;
  if (count > maxPerHour) {
    logger.info(
      { chatId, source, count, maxPerHour },
      'Proactive coordinator: hourly cap reached, releasing lock',
    );
    // 释放锁，让其他源有机会
    await redis.del(lockKey);
    return false;
  }

  return true;
}

/**
 * 标记主动发言已发送。锁已在 tryAcquire 时设置，这里只做日志。
 */
export async function markProactiveSent(
  chatId: number,
  source: string,
): Promise<void> {
  logger.info(
    { chatId, source },
    'Proactive coordinator: message sent',
  );
}
