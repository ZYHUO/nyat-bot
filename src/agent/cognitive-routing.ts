// Deterministic fast/deep/background routing signals.
//
// This module only classifies an already-known turn. It never calls an LLM,
// reads mutable state, or authorizes a side effect. Callers can use the
// decision for shadow telemetry; behavior remains an explicit rollout choice.

import type { JudgeAction, ReplyPath } from '../shared/types.js';

export type CognitiveRoute = 'fast' | 'deep' | 'background';

export type CognitiveComplexitySignal =
  | 'explicit_goal'
  | 'open_debt'
  | 'pending_task'
  | 'task_recovery'
  | 'multi_step_tool'
  | 'external_lookup'
  | 'conflict_or_correction'
  | 'high_risk_side_effect'
  | 'prediction_error'
  | 'long_context';

export interface CognitiveRoutingInput {
  text?: string;
  action?: JudgeAction;
  replyPath?: ReplyPath;
  judgeRule?: string;
  explicitGoal?: boolean;
  openDebtCount?: number;
  pendingTask?: boolean;
  taskRecovery?: boolean;
  requestedToolCount?: number;
  conflict?: boolean;
  correction?: boolean;
  highRisk?: boolean;
  predictionError?: number;
  contextTokens?: number;
  /** Set only for scheduler/tick work that should not block an interactive turn. */
  background?: boolean;
}

export interface CognitiveRoutingDecision {
  route: CognitiveRoute;
  score: number;
  signals: CognitiveComplexitySignal[];
  primarySignal: CognitiveComplexitySignal | null;
  reason: string;
  /** Whether a caller may opt into the bounded cognitive workspace. */
  shouldUseWorkspace: boolean;
}

export interface CognitiveRoutingRollout {
  /** Explicit behavior gate. Telemetry may remain enabled independently. */
  enabled: boolean;
  /** Empty means all chats; non-empty is an allowlist for canary rollout. */
  chatIds?: readonly number[];
}

const GOAL_RE = /(目标|计划|待办|以后记住|持续关注|追踪|提醒我|帮我完成|帮我安排|长期|接下来要)/i;
const CORRECTION_RE = /(不对|不对吧|不是这样|你搞错|错了|纠正|更正|记错|弄错|误会了|wrong|incorrect|correction)/i;
const CONFLICT_RE = /(冲突|争议|吵起来|矛盾|误会|投诉|生气|不满|conflict|dispute|complaint)/i;
const HIGH_RISK_RE = /(删除|清空|覆盖|销毁|支付|购买|转账|部署|上线|发布|写入|修改权限|发给|代发|转发|delete|drop|destroy|pay|purchase|deploy|publish|send)/i;

const SIGNAL_WEIGHT: Record<CognitiveComplexitySignal, number> = {
  explicit_goal: 2,
  open_debt: 2,
  pending_task: 2,
  task_recovery: 2,
  multi_step_tool: 2,
  external_lookup: 1,
  conflict_or_correction: 2,
  high_risk_side_effect: 3,
  prediction_error: 2,
  long_context: 1,
};

const SIGNAL_PRIORITY: CognitiveComplexitySignal[] = [
  'high_risk_side_effect',
  'task_recovery',
  'pending_task',
  'open_debt',
  'conflict_or_correction',
  'prediction_error',
  'multi_step_tool',
  'explicit_goal',
  'external_lookup',
  'long_context',
];

function positiveCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function finiteAbs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.abs(value) : 0;
}

/** Classify a turn without changing behavior or consulting mutable stores. */
export function classifyCognitiveRoute(input: CognitiveRoutingInput = {}): CognitiveRoutingDecision {
  const text = (input.text ?? '').trim();
  const signals = new Set<CognitiveComplexitySignal>();
  const openDebtCount = positiveCount(input.openDebtCount);
  const requestedToolCount = positiveCount(input.requestedToolCount);
  const contextTokens = positiveCount(input.contextTokens);

  if (input.explicitGoal === true || GOAL_RE.test(text)) signals.add('explicit_goal');
  if (openDebtCount > 0) signals.add('open_debt');
  if (input.pendingTask === true) signals.add('pending_task');
  if (input.taskRecovery === true) signals.add('task_recovery');
  if (requestedToolCount >= 2) signals.add('multi_step_tool');
  if (input.replyPath === 'planned') signals.add('external_lookup');
  if (input.conflict === true || input.correction === true || CORRECTION_RE.test(text) || CONFLICT_RE.test(text)) {
    signals.add('conflict_or_correction');
  }
  if (input.highRisk === true || HIGH_RISK_RE.test(text)) signals.add('high_risk_side_effect');
  if (finiteAbs(input.predictionError) >= 0.5) signals.add('prediction_error');
  if (contextTokens >= 9_000) signals.add('long_context');

  const orderedSignals = SIGNAL_PRIORITY.filter((signal) => signals.has(signal));
  const score = orderedSignals.reduce((total, signal) => total + SIGNAL_WEIGHT[signal], 0);
  const hasHighRisk = signals.has('high_risk_side_effect');
  const canBackground = input.background === true && !hasHighRisk && input.action !== 'REPLY';
  const route: CognitiveRoute = canBackground ? 'background' : score >= 2 ? 'deep' : 'fast';
  const primarySignal = orderedSignals[0] ?? null;
  const reason = orderedSignals.length > 0 ? orderedSignals.join(',') : 'no_complexity_signal';

  return {
    route,
    score,
    signals: orderedSignals,
    primarySignal,
    reason,
    shouldUseWorkspace: route !== 'fast',
  };
}

/**
 * Decide whether a classified route may change the caller's behavior.
 *
 * Keeping this predicate pure makes the rollout boundary auditable: a fast
 * route never turns on extra work, and a non-empty chat allowlist cannot leak
 * behavior to other scopes.
 */
export function shouldApplyCognitiveRoute(
  decision: CognitiveRoutingDecision,
  rollout: CognitiveRoutingRollout,
  chatId: number,
): boolean {
  if (!rollout.enabled || decision.route === 'fast') return false;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return false;
  const chatIds = rollout.chatIds ?? [];
  return chatIds.length === 0 || chatIds.includes(chatId);
}
