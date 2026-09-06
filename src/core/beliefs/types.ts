// ────────────────────────────────────────
// Core Belief View — 类型定义 (Phase 0 Task 0.1)
// 统一读接口：旧表继续写，这里只是它们的读投影。
// 置信度只由 host 可验证 outcome 更新，LLM 自报不算数。
// ────────────────────────────────────────

export interface BeliefInput {
  sourceTable: string;
  sourceRowId: number;
  predicate: string;
  summary: string;
  /** 强制：无 evidence 不落库 */
  evidence: string[];
  ttlSec?: number;
}

export type BeliefStatus = 'active' | 'stale' | 'contradicted';

export interface Belief {
  id: number;
  sourceTable: string;
  sourceRowId: number;
  predicate: string;
  summary: string;
  /** host 计算的 Laplace 置信度（写库值，未衰减） */
  confidence: number;
  supportCount: number;
  refuteCount: number;
  lastConfirmedAt: number | null;
  ttlSec: number;
  status: BeliefStatus;
  evidence: string[];
  createdAt: number;
  updatedAt: number;
}

/** 读侧视图：status 可能被 TTL 翻成 stale，confidence 带时间衰减（不写回） */
export interface BeliefView extends Belief {
  /** 读时有效状态（TTL 过期 → stale） */
  effectiveStatus: BeliefStatus;
  /** 衰减后的置信度（读侧计算） */
  decayedConfidence: number;
}
