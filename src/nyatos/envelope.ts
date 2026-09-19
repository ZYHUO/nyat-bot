// ────────────────────────────────────────
// Nyat Trench · L1 包络（Envelope）——对所有发言生效的物理边界
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
// 两种取向的区别是刻意的：real person 不会因为在群里受欢迎就被允许
// 一秒钟回十条，也不会因为回得多就被判"话多"。管的是**形状**，不是**总量**。
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
    const maxBurst = clampInt(addressed ? e.TRENCH_BURST_MAX : e.TRENCH_BURST_MAX_ACTIVE, 1, 60);
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
      : `未发送：你这会儿说得太密了。等 ${Math.ceil(wait)} 秒，或者真有别的事就先做别的。`;
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
