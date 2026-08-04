// ────────────────────────────────────────
// Model 冷却 + 熔断追踪
// ────────────────────────────────────────
//
// 两层保护：
// 1. 429 冷却（原有）：rate limit → 短期跳过（默认 60s）
// 2. 熔断器（新增）：连续失败 N 次 → 跳过一段时间（默认 120s，指数退避）
//    覆盖 timeout / network / 5xx / empty content 等全失败类型
//    成功时重置计数。半开状态：熔断到期后允许 1 次试探。

import type Redis from 'ioredis';

const COOLDOWN_PREFIX = 'xxb:cooldown:';          // 429 短期冷却
const FAIL_PREFIX = 'xxb:circuit:fail:';          // 连续失败计数
const TRIP_PREFIX = 'xxb:circuit:trip:';          // 熔断状态（带 TTL）

const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_BREAKER_SECONDS = 120;
const DEFAULT_BREAKER_MAX_SECONDS = 1800;         // 30min 上限
const BACKOFF_MULTIPLIER = 1.5;

export class CooldownTracker {
  constructor(private readonly redis: Redis) {}

  // ── 429 冷却（原有逻辑）──

  async setCooldown(model: string, ttlSeconds = DEFAULT_COOLDOWN_SECONDS): Promise<void> {
    await this.redis.set(COOLDOWN_PREFIX + model, '1', 'EX', ttlSeconds);
  }

  async isCoolingDown(model: string): Promise<boolean> {
    // 429 冷却 OR 熔断中
    if ((await this.redis.exists(COOLDOWN_PREFIX + model)) === 1) return true;
    if ((await this.redis.exists(TRIP_PREFIX + model)) === 1) return true;
    return false;
  }

  async getRemainingSeconds(model: string): Promise<number> {
    const cd = await this.redis.ttl(COOLDOWN_PREFIX + model);
    const br = await this.redis.ttl(TRIP_PREFIX + model);
    return Math.max(cd > 0 ? cd : 0, br > 0 ? br : 0);
  }

  // ── 熔断器 ──

  /**
   * 记录一次失败。连续失败达到阈值 → 熔断。
   * 返回是否触发了熔断（方便日志）。
   */
  async recordFailure(
    model: string,
    _errorType: string,
    opts?: { threshold?: number; breakerSec?: number; maxSec?: number },
  ): Promise<boolean> {
    const threshold = opts?.threshold ?? DEFAULT_FAILURE_THRESHOLD;
    const baseSec = opts?.breakerSec ?? DEFAULT_BREAKER_SECONDS;
    const maxSec = opts?.maxSec ?? DEFAULT_BREAKER_MAX_SECONDS;

    const key = FAIL_PREFIX + model;
    const count = await this.redis.incr(key);
    // 首次设 TTL（24h），让计数 eventual expire
    if (count === 1) await this.redis.expire(key, 86400);

    if (count >= threshold) {
      // 指数退避：count=3 → base×1, count=6 → base×1.5, count=9 → base×2.25 ...
      // 不重置计数 — 让连续熔断周期累积，实现真正的升级退避。
      // 成功时 recordSuccess 才重置计数。
      const exponent = Math.floor(count / threshold) - 1;
      const ttl = Math.min(Math.round(baseSec * Math.pow(BACKOFF_MULTIPLIER, exponent)), maxSec);
      await this.redis.set(TRIP_PREFIX + model, String(ttl), 'EX', ttl);
      return true;
    }
    return false;
  }

  /** 成功时重置失败计数 */
  async recordSuccess(model: string): Promise<void> {
    await this.redis.del(FAIL_PREFIX + model);
  }

  /** 熔断是否处于半开状态（TTL 快到期，允许试探） */
  async isHalfOpen(model: string, halfOpenWindowSec = 15): Promise<boolean> {
    const ttl = await this.redis.ttl(TRIP_PREFIX + model);
    return ttl > 0 && ttl <= halfOpenWindowSec;
  }
}
