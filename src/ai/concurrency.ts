// ─────────────────────────────────────────────────────────────────────
// 客户端并发闸——别把 provider 的并发限额撞爆
// ─────────────────────────────────────────────────────────────────────
//
// 2026-09-21 实测：StepFun 的限额是 **8**，我们一度打到 9-12；
// 另一家限额 **10**，我们打到 11-12。日志里
// `Rate limited: concurrency reached, current: 9, limit: 8` **529 次**、
// `current: 11, limit: 10` **146 次**——加起来 675 次白扔的调用。
//
// 而 `src/ai/` 此前**没有任何客户端侧并发控制**：heart、shadow、
// topic-scan、deep-reflection、distiller、post-task 同时开火就超。
// provider 侧返回 429 → 我们的熔断器记一次失败 → 冷却 60s → 下一批又超。
// **撞限额本身在制造它想避免的拥塞。**
//
// 做法：一个极简信号量，按 (endpoint, apiKey) 分组——同一账号共享额度，
// 不同账号各算各的（这正是 smart-group 的 diversifyByUpstream 那条规则）。
// 拿不到就排队等，不报错：等待好过被 429 后冷却一分钟。

/**
 * 每个账号同时在飞的调用上限。
 *
 * StepFun 的限额是 8、另一家 10。取 6 给 provider 自己的内部并发留余量。
 * 导出是因为 `reply-with-tools.ts` 直接走 AI SDK 的 generateText、绕过了
 * callModel，得自己在那边 acquire。
 */
export const AI_MAX_CONCURRENCY_PER_ACCOUNT = 6;
/**
 * 排队上限。超过就放行（超发一次 429 好过等掉半个超时预算）。
 *
 * round 115 实测均等 4385ms，而调用方的 maxTimeoutMs 是 10-20s。取 1500ms：
 * 明显小于任何超时预算，又足够让正常排队（几十到几百毫秒）起作用。
 */
export const CONCURRENCY_MAX_WAIT_MS = 1500;

interface Bucket { active: number; waiters: Array<() => void>; }

const buckets = new Map<string, Bucket>();

function bucketOf(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) { b = { active: 0, waiters: [] }; buckets.set(key, b); }
  return b;
}

import { incrCounter } from '../metrics/registry.js';
import { logger } from '../shared/logger.js';

/** 测试用：清空所有计数。 */
export function __resetConcurrencyForTest(): void {
  buckets.clear();
}

/** 当前活跃数（测试/诊断用）。 */
export function activeConcurrency(key: string): number {
  return bucketOf(key).active;
}

/**
 * 取一个并发位。`limit <= 0` 表示不限制。
 * 返回的 release 必须调用（放 try/finally 里）。
 */
export async function acquireConcurrency(
  key: string,
  limit: number,
): Promise<() => void> {
  if (!(limit > 0)) return () => {};
  const b = bucketOf(key);
  if (b.active < limit) {
    b.active++;
    return () => release(b);
  }
  // **排队时长要记账。** round 95 的教训：并发闸装了两个位置，等长窗口对比
  // 五项失败全差，而三种解释（闸在帮倒忙 / provider 真坏了 / 对照组偏乐观）
  // 分不清——因为没有"到底排了多久"这个数。
  //
  //   · 排队久 → 假设 ①：闸把调用堵死，撞的是 maxTimeoutMs 不是 429
  //   · 排队短而失败多 → 假设 ②：没人在等，是 provider 自己坏
  //
  // 一个计数器就能分开，之前没有它，只能停在"原因未定"。
  const queuedAt = Date.now();
  // **排队要有上限。**
  //
  // round 115 实测：等过 328 次、总等 1438s、**均 4385ms**、>2s 的 227 次。
  // 这个闸平均让每次调用多等 4.4 秒，而调用方的 `maxTimeoutMs` 只有 10-20s
  // ——等完再跑，大概率直接超时。
  //
  // round 95 我把"闸在帮倒忙"列为三种解释之一但分不清；round 96 加了排队计时；
  // 现在数字说话了：**那个假设成立**。
  //
  // 限额仍然要守（round 81 实测撞限额 529 次/天），但**等太久比稍微超一点更贵**：
  // 超一点 = 一次 429 + 60s 冷却；等 4.4 秒 = 烧掉半个超时预算 + 拖慢整批 tick。
  // 所以超过 CONCURRENCY_MAX_WAIT_MS 就放行，并计数——超发变成可观测的一次 429，
  // 而不是不可观测的四秒半停顿。
  let entry: (() => void) | undefined;
  const waiter = (): void => { entry?.(); };
  const raced = await Promise.race([
    new Promise<'ok'>((resolve) => { entry = () => resolve('ok'); b.waiters.push(waiter); }),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), CONCURRENCY_MAX_WAIT_MS).unref?.();
    }),
  ]);
  if (raced === 'timeout') {
    // 把自己从等待队列里摘掉（如果还在），然后放行——不占位置，release 是 no-op。
    const i = b.waiters.indexOf(waiter);
    if (i >= 0) b.waiters.splice(i, 1);
    incrCounter('llm_concurrency_wait_timeout_total', { bucket: key.slice(0, 60) });
    logger.debug(
      { bucket: key.slice(0, 60), waitedMs: Date.now() - queuedAt, cap: CONCURRENCY_MAX_WAIT_MS },
      'concurrency gate: wait exceeded cap, proceeding anyway',
    );
    return () => {};
  }
  // 被唤醒时位置已经留给本调用者了（release 里直接转交，不再检查 limit）
  const waitedMs = Date.now() - queuedAt;
  incrCounter('llm_concurrency_wait_ms_total', { bucket: key.slice(0, 60) }, waitedMs);
  incrCounter('llm_concurrency_waits_total', { bucket: key.slice(0, 60) });
  if (waitedMs > 2000) {
    incrCounter('llm_concurrency_slow_waits_total', { bucket: key.slice(0, 60) });
  }
  return () => release(b);
}

function release(b: Bucket): void {
  const next = b.waiters.shift();
  if (next) {
    // 位置直接转交下一位，active 不变
    next();
    return;
  }
  b.active = Math.max(0, b.active - 1);
}
