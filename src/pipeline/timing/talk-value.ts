// ────────────────────────────────────────
// P1-C: talk_value 频率阈值层 — gate LLM 之前的确定性闸
// ────────────────────────────────────────
//
// **纯 LLM 驱动定位 (2026-08-06): 这不是意图规则引擎。** 它是 MaiBot 的
// 成本保护闸：避免每条被动消息都烧一次 gate LLM。意图判断（该不该回）
// 全部由 Heart/gate LLM 做出；本层只决定"攒够多少条消息才值得调一次 LLM"。
// 纯 LLM 驱动 ≠ 无成本控制——无此闸的群聊会每分钟调几十次 LLM。
//
// MaiBot(runtime.py:636-669/748-753/870-899/1451-1504)的 gate 不是每条消息
// 都跑:先过一个 0 成本的频率闸 —— 攒够 ceil(1/有效频率) 条新消息才思考一次,
// 配合空闲补偿(沉默时间按最近 30 分钟平均消息间隔折算成等效消息数)。大部分
// "沉默"由这层产生,LLM gate 只在"值得想一想"的时刻被调用。
//
// 语义要点:
//   - talkValue >= 1 → 层关闭(恒 pass)。**必须**在 focusAdjust 之前判,否则
//     默认 focus 基线 0.3 → adjust 0.8 会让 talkValue=1.0 悄悄变成阈值 2。
//   - 空闲折算封顶 threshold-1:纯沉默永远不够阈值,至少要 1 条真实消息。
//   - 未达阈值 → 调用方 defer 延迟重评(P0-B),消息不丢。
//   - direct/@ 在 runTimingGate 上游 short-circuit,永远不受本层影响。
//   - per-chat 覆盖:Redis GET xxb:timing:talkvalue:{chatId}(运维手工设)。

import { getRedis } from '../../db/redis.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { getRecentTimestamps } from '../../tracking/activity.js';
import { getFocus } from '../turn/focus.js';
import type { ChatTimingState } from './chat-runtime.js';

export const TALKVALUE_KEY_PREFIX = 'xxb:timing:talkvalue:';
/** 空闲补偿观察窗(MaiBot 30min)。 */
export const IDLE_WINDOW_SEC = 1800;
/** <5s 的 burst 间隔不代表真实发言节奏,不计入样本(MaiBot 同值)。 */
export const BURST_GAP_SEC = 5;
/** 平均间隔下限,防统计值过小让沉默折算过快(MaiBot 同值)。 */
export const AVG_INTERVAL_FLOOR_SEC = 30;
/** 样本不足(<2 个有效间隔)时的保守兜底。 */
export const AVG_INTERVAL_DEFAULT_SEC = 120;

/** per-chat Redis 覆盖 → env TIMING_TALK_VALUE。解析失败/越界按无覆盖处理。 */
export async function getChatTalkValue(chatId: number): Promise<number> {
  const fallback = env().TIMING_TALK_VALUE;
  try {
    const raw = await getRedis().get(`${TALKVALUE_KEY_PREFIX}${chatId}`);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n <= 1) return n;
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'getChatTalkValue read failed (fallback to env)');
  }
  return fallback;
}

/** focus 调制乘子(MaiBot talk_frequency_adjust 的 focus 版):0.5+focus,clamp [0.5,1.5]。 */
export function focusAdjust(focus: number): number {
  return Math.min(1.5, Math.max(0.5, 0.5 + focus));
}

/** 30min 窗口消息时间戳(升序 epoch 秒)→ 平均间隔秒(去 burst、floor、兜底)。 */
export function computeAvgIntervalSec(timestampsSec: number[]): number {
  const intervals: number[] = [];
  for (let i = 1; i < timestampsSec.length; i++) {
    const gap = timestampsSec[i]! - timestampsSec[i - 1]!;
    if (gap >= BURST_GAP_SEC) intervals.push(gap);
  }
  if (intervals.length < 2) return AVG_INTERVAL_DEFAULT_SEC;
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return Math.max(avg, AVG_INTERVAL_FLOOR_SEC);
}

export interface TalkValueVerdict {
  pass: boolean;
  threshold: number;
  count: number;
  /** count + 空闲折算(封顶 threshold-1)。 */
  equivalent: number;
  /** pass=false 时:预计凑够等效消息的延迟(供 defer 排程)。 */
  retryAfterMs?: number;
}

const PASS: TalkValueVerdict = { pass: true, threshold: 1, count: 1, equivalent: 1 };

/**
 * 阈值裁决(MaiBot _schedule_message_turn 语义):
 *   effective = talkValue × focusAdjust(仅 TURN_FOCUS_ENABLED)
 *   threshold = ceil(1/effective)
 *   idleEquiv = min(idleSec/avg, threshold-1)
 *   pass = count + idleEquiv >= threshold
 * 任何内部错误 → fail-open pass(宁可多烧一次 gate LLM,不丢消息)。
 */
export async function checkTalkValueThreshold(args: {
  chatId: number;
  state: ChatTimingState;
}): Promise<TalkValueVerdict> {
  try {
    const e = env();
    const talkValue = await getChatTalkValue(args.chatId);
    // 层关闭:必须在 focusAdjust 前判,保证默认 1.0 绝对 no-op
    if (talkValue >= 1) return PASS;

    let adjust = 1;
    if (e.TURN_FOCUS_ENABLED) {
      try {
        adjust = focusAdjust(await getFocus(args.chatId));
      } catch { /* 无 focus 按 1 */ }
    }
    const effective = Math.min(1, Math.max(0.01, talkValue * adjust));
    const threshold = Math.ceil(1 / effective);
    if (threshold <= 1) return PASS;

    // 触发这次评估的消息本身已计数(pipeline bump 在 gate 之前);兜底至少 1。
    const count = Math.max(1, args.state.gatePendingCount ?? 1);
    if (count >= threshold) {
      return { pass: true, threshold, count, equivalent: count };
    }

    // 空闲补偿:自"开始攒这批消息"以来的沉默时长按平均间隔折算
    const sinceMs =
      args.state.gatePendingSince ??
      args.state.lastGateAt ??
      args.state.lastBotReplyAt ??
      Date.now();
    const idleSec = Math.min(IDLE_WINDOW_SEC, Math.max(0, (Date.now() - sinceMs) / 1000));
    const timestamps = await getRecentTimestamps(args.chatId, IDLE_WINDOW_SEC);
    const avgIntervalSec = computeAvgIntervalSec(timestamps);
    const idleEquiv = Math.min(idleSec / avgIntervalSec, threshold - 1);
    const equivalent = count + idleEquiv;
    if (equivalent >= threshold) {
      return { pass: true, threshold, count, equivalent };
    }

    // review #3:重评时刻必须夹在"可达"范围内 —— idleSec 有 30min 封顶,
    // 低 talk_value 慢群里 (threshold-count)*avg 可能超过封顶,按原式排的
    // 重评永远不可能满足阈值。夹到可达视界后,重评要么真的凑够了,要么
    // 很快耗尽 defer 预算穿透给 LLM 裁决(gate 短路层的 hasDeferBudget)。
    const neededIdleSec = (threshold - count) * avgIntervalSec;
    const reachableIdleSec = Math.min(neededIdleSec, IDLE_WINDOW_SEC);
    const retryAfterMs = Math.max(0, Math.round((reachableIdleSec - idleSec) * 1000));
    return { pass: false, threshold, count, equivalent, retryAfterMs };
  } catch (err) {
    logger.debug({ err, chatId: args.chatId }, 'checkTalkValueThreshold failed (fail-open)');
    return PASS;
  }
}
