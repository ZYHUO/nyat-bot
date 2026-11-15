// ────────────────────────────────────────
// Nyat Trench · L1 包络（Envelope）——对所有发言生效的物理边界（小时总量界）
// ────────────────────────────────────────
//
// 论文 §6 约束 2 的缺口，2026-09-19 实测钉死：
//
//   participation budget（6 条/小时 + 90 秒间距）只拦**主动发言**——
//   "被叫到的消息不受此限"。而生产里 1,572 次群发送**全部带引用锚点**，
//   全部算"被叫到"，全部豁免。最忙的群 266 条/天 = 11 条/小时，
//   **已经超过 6 条/小时的上限而没有任何东西在管**。
//
//   结论：物理边界在有引用锚点的那条路上是个洞，而那条路承载全部流量。
//   这不影响今天的活性（bot 本来就该爱说话），但它意味着 Phase 2 一旦把
//   判定点上真身（投影：最忙群 22% → 86%，放大 3.9x），**没有任何东西能接住**。
//
// 所以这里加的是**突发包络**，不是节制：
//   主动发言：沿用既有 6 条/小时 + 90 秒间距（不许刷屏）
//   被叫到的：允许密，但不许**爆**——TRENCH_BURST_MAX 条 / TRENCH_BURST_WINDOW_SEC
//
// 默认参数是**回测出来的**，不是设计的（见 env.ts 里的注释）：
// 第一版我用 5 分钟窗 + 8/3 条，理由是"管突发形状不管总量"。回测打了脸——
// bot 本来就会在 5 分钟里突到 19 条（小时窗峰值 107），那个参数会拦掉 23%。
// 真正的缺口是判定点投影的**总量放大**（最忙群 266 → ~1048 条/天），
// 所以上界应该落在"现在看不见、放大后接得住"的那段空白里。
//
// 三态（TRENCH_ENVELOPE_MODE）：
//   off     —— 不读不写（默认）
//   shadow  —— 只记录"这一条本来会被拦"，绝不拦截（先看数再开）
//   enforce —— 真拦

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

const KEY_BURST = 'xxb:trench:burst:';

export type EnvelopeMode = 'off' | 'shadow' | 'enforce';

export interface EnvelopeVerdict {
  ok: boolean;
  /** blocked_by_burst / blocked_by_spacing / blocked_by_hourly */
  why?: string;
  /** 建议等多少秒再试（供"世界回弹"说人话） */
  retryAfterSec?: number;
  mode: EnvelopeMode;
}

function mode(): EnvelopeMode {
  try {
    const m = env().TRENCH_ENVELOPE_MODE;
    return m === 'shadow' || m === 'enforce' ? m : 'off';
  } catch {
    return 'off';
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.trunc(Math.min(hi, Math.max(lo, v)));
}

/**
 * 包络检查。
 *
 * @param addressed 这条是不是"有人在叫我"（有引用锚点 / DM / @我）。
 *                  被叫到的走宽松的突发包络；主动的走严格的小时预算。
 */
export async function checkEnvelope(
  chatId: number,
  addressed: boolean,
): Promise<EnvelopeVerdict> {
  const m = mode();
  if (m === 'off') return { ok: true, mode: m };
  if (!Number.isSafeInteger(chatId) || chatId === 0) return { ok: true, mode: m };

  try {
    const e = env();
    const redis = getRedis();
    const now = Math.floor(Date.now() / 1000);
    const winSec = clampInt(e.TRENCH_BURST_WINDOW_SEC, 30, 1800);
    // 被叫到的放宽，主动的收紧：连回 8 个问题是尽职，主动插 8 次话是刷屏。
    // 这正是原 budget "direct 豁免"语义的延续，只是把豁免做成了**程度**而不是**全免**。
    const maxBurst = await scaledBurst(addressed ? e.TRENCH_BURST_MAX : e.TRENCH_BURST_MAX_ACTIVE, chatId);
    // 滑动窗口：桶式（窗口整除），足够防爆且零清理成本。
    const bucket = Math.floor(now / winSec);
    const k = `${KEY_BURST}${chatId}:${bucket}`;
    const used = Number(await redis.get(k));

    if (Number.isFinite(used) && used >= maxBurst) {
      const retryAfterSec = (bucket + 1) * winSec - now;
      // 被叫到的也允许爆到上限——只是爆完要停一下。
      return { ok: false, why: 'blocked_by_burst', retryAfterSec, mode: m };
    }
    return { ok: true, mode: m };
  } catch (err) {
    // 读失败一律放行：包络是护栏，不是单点故障。
    logger.debug({ err, chatId }, 'envelope check failed (fail-open)');
    return { ok: true, mode: 'off' };
  }
}

/**
 * 按群活跃度缩放突发上限。
 *
 * 2026-09-21 加，对应用户的原话："日常都有点过高频率，只有在群友都活跃度高的
 * 时候高活跃"。在那之前 TRENCH_BURST_MAX / _ACTIVE 是**扁平常量**——冷清群和
 * 热聊群共用同一个天花板，于是 Quiet 群里 bot 照样能每小时主动插 20 次。
 *
 * 缩放依据是宿主**本来就在测**的群活跃度（xxb:activity:{chatId} 这个 ZSET，
 * recordMessage 每条入站都写），不新增任何测量：
 *
 *   messages5min ≥ 20  热聊   ×1.5
 *   ≥ 10               活跃   ×1.25
 *   ≥ 3                正常   ×1.0
 *   ≥ 1                冷清   ×0.5
 *   0                  沉寂   ×0.25
 *
 * 下限 1：再冷清也不许把上限压到 0——那会让包络从"护栏"变成"静音"，
 * 而被叫到的消息仍然必须能出去（无视直接提问是另一种失败）。
 *
 * 读不到活跃度（Redis 抖了）→ 按 1.0 处理，即退回改动前的扁平常量。
 */
async function scaledBurst(base: number, chatId: number): Promise<number> {
  const clamped = clampInt(base, 1, 60);
  if (!env().TRENCH_ENVELOPE_ACTIVITY_SCALED) return clamped;
  let factor = 1;
  try {
    const { getActivitySummary } = await import('../tracking/activity.js');
    const s = await getActivitySummary(chatId);
    factor = s.messages5min >= 20 ? 1.5
      : s.messages5min >= 10 ? 1.25
      : s.messages5min >= 3 ? 1
      : s.messages5min >= 1 ? 0.5
      : 0.25;
  } catch {
    // 读失败按 1.0 —— 与改动前一致，不因基础设施故障改变行为
  }
  return Math.max(1, Math.min(60, Math.round(clamped * factor)));
}

/** 记一次发言进突发窗口。由发送成功方调用（发送**之后**）。 */
export async function spendEnvelope(chatId: number): Promise<void> {
  if (mode() === 'off') return;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return;
  try {
    const e = env();
    const redis = getRedis();
    const winSec = clampInt(e.TRENCH_BURST_WINDOW_SEC, 30, 1800);
    const bucket = Math.floor(Date.now() / 1000 / winSec);
    const k = `${KEY_BURST}${chatId}:${bucket}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, winSec * 2);
  } catch (err) {
    logger.debug({ err, chatId }, 'envelope spend failed (non-critical)');
  }
}

/**
 * 拦下时给模型看的那句话。
 *
 * 刻意区分两种失败：爆了（形状问题）和说太多了（总量问题）。
 * 人听得懂这两种区别，模型也该听得懂。
 */
export function renderEnvelopeBlock(v: EnvelopeVerdict, addressed: boolean): string {
  const wait = v.retryAfterSec ?? 0;
  if (v.why === 'blocked_by_burst') {
    return addressed
      ? `未发送：你这会儿回得太密了（${Math.ceil(wait)} 秒内已经回了一批）。不是不让你回，是一口气回太多别人跟不上——缓一下，或者把想说的并成一条。`
      : `未发送：你说得太快了，等 ${Math.ceil(wait)} 秒。不是不让你说，是这会儿没人叫你，而你刚才已经说得够密。`;
  }
  return '未发送：你这一段话说得太快了。歇一下再说。';
}

/** 观测：影子模式下记录"这一条本来会被拦"。 */
export function observeEnvelopeShadow(
  chatId: number,
  addressed: boolean,
  v: EnvelopeVerdict,
): void {
  if (v.mode !== 'shadow' || v.ok) return;
  logger.info(
    { chatId, addressed, why: v.why, retryAfterSec: v.retryAfterSec },
    'envelope shadow: this reply would have been blocked',
  );
}
