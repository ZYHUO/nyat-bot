// ────────────────────────────────────────
// Core Belief View — 置信度（host 计算，LLM 永远不写）
// Laplace 平滑 + 读侧时间衰减（不写回，与 mood.ts decay 同款模式）
// ────────────────────────────────────────

/** 无数据时 = 0.5（先验中立） */
export function laplaceConfidence(support: number, refute: number): number {
  return (support + 1) / (support + refute + 2);
}

/**
 * 读侧时间衰减：越旧越往 0.5 回落。过期（age >= ttl）直接 0.5。
 * 纯函数，不写回 DB。
 */
export function decayedConfidence(c: number, ageSec: number, ttlSec: number): number {
  if (ageSec >= ttlSec) return 0.5;
  return 0.5 + (c - 0.5) * (1 - ageSec / ttlSec);
}
