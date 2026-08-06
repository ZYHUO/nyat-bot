// ────────────────────────────────────────
// Prompt-cache warmup — 保持回复模型的静态 system 前缀在 DeepSeek 端"热"着
// ────────────────────────────────────────
//
// 诊断:回复 prompt 缓存命中率 ~0.24%。system 前缀其实已稳定(per-user 数据早搬去 user turn,
// 无 per-user persona 文件),但流量稀疏(~28 条/小时),4k-token 的 system 前缀在 DeepSeek
// 端的缓存 TTL 内被挤掉 → 下次又 miss。
// 对策:每 CACHE_WARMUP_INTERVAL_MIN 分钟,拿**与真实回复逐字节相同**的静态 system 前缀
// (buildSystemPrompt('normal'),无 userId → 默认人设)发一个极小请求,让前缀保持热,
// 真实回复就能命中那 4k token 的缓存价。默认关(CACHE_WARMUP_ENABLED)。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import { buildSystemPrompt } from '../pipeline/reply/prompt-builder.js';

export async function runCacheWarmup(): Promise<void> {
  if (!env().CACHE_WARMUP_ENABLED) return;
  // 睡着时没有回复流量,预热无意义且白花钱 —— 和其它主动 cron 一样跳过(idle/proactive-scan 同款)。
  try {
    const { isAsleep } = await import('../tracking/sleep.js');
    if (await isAsleep()) return;
  } catch { /* non-critical */ }
  try {
    // 与**主流 normal 档、默认人设**回复同一份 system 前缀(DeepSeek 自动缓存最长公共前缀 = 这段 system)。
    // 注:pro/max 档、per-user persona、merged-tools 的 system 前缀不同,预热不覆盖那些少数路径。
    const system = buildSystemPrompt();
    await callWithFallback({
      usage: 'reply',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'ping(系统预热,忽略,只回 ok)' },
      ],
      maxTokens: 8,
      suppressMetrics: true, // 别把预热合成流量混进它本要观测的 reply 指标
    });
    logger.debug('cache warmup ping sent');
  } catch (err) {
    logger.debug({ err }, 'cache warmup failed (non-critical)');
  }
}
