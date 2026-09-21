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

/**
 * 启动时清掉遗留的熔断/冷却状态。
 *
 * 2026-09-21 round 87 实测：**重启后的前 5 分钟是全天最差的窗口**——
 * `all candidates skipped` 194 次（20-25 分钟窗口只有 36 次，5 倍），
 * `Circuit breaker tripped` 62 次（那个窗口 6 次，10 倍）。
 *
 * 原因不是 round 86 猜的"零成功降权"，而是**这些键活在 Redis 里、跨重启不过期**：
 *   · `xxb:circuit:trip:<model>`  TTL 最长 1800s（30 分钟）
 *   · `xxb:circuit:fail:<model>`  TTL 86400s，且**只有成功才重置**
 * 重启前被熔断的 label，重启后接着被熔断——一个新进程开局就背着旧账。
 * 实测重启瞬间Redis 里躺着 5 个 trip 键（TTL 86-1392s）和 20 个 fail 计数。
 *
 * 熔断器的语义是"这个 provider **此刻**在失败，别锤它"。重启本身就是
 * "此刻"的天然边界——旧进程的失败不该继续押着新进程。
 * 清掉之后新进程从干净状态开始，真还在失败的 provider 几十秒内会重新熔断。
 */

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
    // 24h TTL 每次失败都刷新（原来是只在 count===1 时设一次）。
    //
    // 2026-09-21 round 103。原来的写法让 TTL 的含义变成"自第一次失败起 24h"，
    // 于是：周一失败 2 次、之后一直没被调用、周五再失败 1 次 → count=3 → 立刻熔断。
    // **周一的失败参与了周五的决策**，而中间隔了四天、四天里这个 model 没出过任何问题。
    //
    // 这和 round 102 修的是同一类病（累计值做实时判断，round 87 的熔断键也是）：
    // 一个不会随时间过期的计数，会把旧状态押到新时段上。刷新 TTL 之后，
    // 24h 的含义变成"24 小时没有活动就清零"——那本来就是这个 TTL 的安全网意图
    // （注释写的是 eventual expire，不是"从第一次失败算起"）。
    //
    // 升级退避的语义不受影响：连续失败时每次都会刷新，计数照旧累积。
    await this.redis.expire(key, 86400);

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

  /**
   * 清掉遗留的熔断/冷却键。启动时调一次。
   *
   * 为什么：round 87 实测重启后前 5 分钟是全天最差窗口——`all candidates
   * skipped` 194 次（稳定期 36 次的 5 倍）、`Circuit breaker tripped` 62 次
   * （稳定期 6 次的 10 倍）。原因不是零成功降权，而是这些键活在 Redis 里、
   * **跨重启不过期**：trip 最长 1800s、fail 计数 86400s 且只有成功才重置。
   * 重启前被熔断的 label 重启后接着被熔断——新进程开局背着旧账。
   *
   * 熔断器的语义是"这个 provider **此刻**在失败，别锤它"。重启本身就是
   * "此刻"的天然边界。清掉后真还在失败的 provider 几十秒内会重新熔断，
   * 代价很小；不清则每次重启白送 5-30 分钟的低可用期。
   *
   * 只清 trip 和 fail 计数，**不动 cooldown**——429 的 Retry-After 是
   * provider 明确要求的等待，那是外部信息，不是我们的判断。
   */
  async resetBreakerState(): Promise<number> {
    let cleared = 0;
    for (const prefix of [TRIP_PREFIX, FAIL_PREFIX]) {
      const keys = await this.redis.keys(prefix + '*');
      for (const k of keys) { await this.redis.del(k); cleared++; }
    }
    return cleared;
  }
}
