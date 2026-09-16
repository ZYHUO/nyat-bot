// ────────────────────────────────────────
// Group Pace — per 群节奏拟合 (H1.2)
// 真人回复间隔就是该群的"心跳":快群(5s 一条)和慢群(10 分钟一条)
// 的 bot 必须用不同的延迟分布。base 采样逻辑复用 latency-model
// 的重尾形状,这里只负责"base 从哪来"。
// ────────────────────────────────────────

import { sampleHumanDelay, type DelayOptions } from "../reply/latency-model.js";

export const DEFAULT_PACE_BASE_SEC = 2.5;
export const MIN_PACE_BASE_SEC = 0.8;
export const MAX_PACE_BASE_SEC = 20;
/** 取最近 N 条算中位间隔(防远古消息污染) */
export const PACE_WINDOW = 20;

/** 中位人类回复间隔 → bot 延迟 base(15% 分位:跟上但不抢话) */
export function fitGroupPace(messageTimestampsSec: number[], messagesLast1Min: number): number {
  if (messageTimestampsSec.length < 2) return DEFAULT_PACE_BASE_SEC;
  const ts = [...messageTimestampsSec].sort((a, b) => a - b).slice(-PACE_WINDOW);
  if (ts.length < 2) return DEFAULT_PACE_BASE_SEC;
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianGap = gaps.length % 2 === 1
    ? gaps[mid]!
    : (gaps[mid - 1]! + gaps[mid]!) / 2;
  if (!(medianGap > 0)) return DEFAULT_PACE_BASE_SEC;
  let base = medianGap * 0.15;
  // 当前正热聊(1 分钟 ≥8 条):再快 40%,跟上节奏
  if (messagesLast1Min >= 8) base *= 0.6;
  return Math.min(MAX_PACE_BASE_SEC, Math.max(MIN_PACE_BASE_SEC, base));
}

/** per 群 base + 重尾采样 = 最终延迟(秒) */
export function sampleGroupDelay(baseSec: number, opts: DelayOptions = {}): number {
  return sampleHumanDelay(baseSec, opts);
}
