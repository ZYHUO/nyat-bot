// ────────────────────────────────────────
// Turn Actor — G9 per-chat focus/注意力标量(0..1,指数衰减)
// ────────────────────────────────────────
//
// 人在群里的投入是连续的:聊得起劲时秒回、多说、敢接话;半挂机时偶尔
// 一句;完全没在看时沉默。xxb 此前是开/关(回 or 不回,全套机械齐上)。
// focus 把它变成连续旋钮,**调制而不是门控**:
//   - 高 focus → 去抖窗口更短(回得快)、judge 门槛更低(更愿意接)、
//     自我接话概率更高
//   - 低 focus → 一切反向
//
// 事件:bot 发言 +0.25 | direct 交互 +0.2 | 普通消息 +0.03 |
//       gate no_action -0.15 | gate wait -0.05 | 模型主动沉默 -0.1
// 衰减:半衰期 10 分钟(读取时惰性计算,无 cron)。
//
// 注意:proactive willingness(cron 主动开口)是另一条线,这里只调制
// 反应式路径,避免双重调制(见 docs/turn-actor/second-opinions.md §2.9)。

import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const FOCUS_KEY = (chatId: number) => `xxb:turn:focus:${chatId}`;
const HALF_LIFE_MS = 10 * 60 * 1000;
const KEY_TTL_SEC = 6 * 60 * 60;
/** 新 chat / 完全衰减后的基线 */
const BASELINE = 0.3;

export type FocusEvent =
  | 'bot_spoke'
  | 'direct_interaction'
  | 'passive_message'
  | 'gate_no_action'
  | 'gate_wait'
  | 'model_silent';

const EVENT_DELTA: Record<FocusEvent, number> = {
  bot_spoke: 0.25,
  direct_interaction: 0.2,
  passive_message: 0.03,
  gate_no_action: -0.15,
  gate_wait: -0.05,
  model_silent: -0.1,
};

function decay(value: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return value;
  const decayed = BASELINE + (value - BASELINE) * Math.pow(0.5, elapsedMs / HALF_LIFE_MS);
  return Math.min(1, Math.max(0, decayed));
}

/** Current focus level (lazy-decayed). Returns BASELINE when unknown or flag off. */
export async function getFocus(chatId: number): Promise<number> {
  if (!env().TURN_FOCUS_ENABLED) return BASELINE;
  try {
    const raw = await getRedis().hgetall(FOCUS_KEY(chatId));
    if (!raw['value']) return BASELINE;
    return decay(Number(raw['value']), Date.now() - Number(raw['at'] ?? Date.now()));
  } catch {
    return BASELINE;
  }
}

/** Apply a focus event. Fire-and-forget safe; no-op when flag off. */
export async function bumpFocus(chatId: number, event: FocusEvent): Promise<number> {
  if (!env().TURN_FOCUS_ENABLED) return BASELINE;
  try {
    const redis = getRedis();
    const key = FOCUS_KEY(chatId);
    const raw = await redis.hgetall(key);
    const now = Date.now();
    const current = raw['value']
      ? decay(Number(raw['value']), now - Number(raw['at'] ?? now))
      : BASELINE;
    const next = Math.min(1, Math.max(0, current + EVENT_DELTA[event]));
    await redis.hset(key, 'value', String(next), 'at', String(now));
    await redis.expire(key, KEY_TTL_SEC);
    return next;
  } catch (err) {
    logger.debug({ err, chatId, event }, 'bumpFocus failed (non-critical)');
    return BASELINE;
  }
}

/**
 * 去抖窗口调制因子:focus 1 → 0.25×(锁定对话,回得快),
 * focus 0 → 1.75×(半挂机,多等等)。BASELINE(0.3) ≈ 1.3×。
 */
export function debounceFactor(focus: number): number {
  return Math.min(1.75, Math.max(0.25, 1.75 - 1.5 * focus));
}

/**
 * Judge L1 REPLY 接受门槛调制:focus 1 → 0.6(更愿意接),
 * focus 0 → 0.8(默认沉默偏置)。
 */
export function judgeReplyBar(focus: number): number {
  return Math.min(0.85, Math.max(0.6, 0.8 - 0.2 * focus));
}

/** 自我接话概率调制:focus 1 → 0.45,focus 0 → 0.15。 */
export function followupProbability(focus: number): number {
  return Math.min(0.45, Math.max(0.15, 0.15 + 0.3 * focus));
}
