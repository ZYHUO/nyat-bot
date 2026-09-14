// Host-owned Agency rollout policy.
//
// The policy is deliberately separate from action validation and adapter
// execution: callers can record a proposal in shadow/advisory mode without
// accidentally granting it side effects. Rollout decisions are deterministic,
// scoped, and fail closed when configuration is malformed or incomplete.

import { env } from '../env.js';
import { scopeKey } from '../shared/cognitive-scope.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';
import type { AgencyAction } from './agency.js';

export type AgencyRuntimeMode = 'shadow' | 'advisory' | 'canary' | 'authority';
export type AgencyRisk = 'read' | 'reversible' | 'irreversible';

export interface AgencyPolicyBudget {
  maxLlmCalls: number;
  maxToolCalls: number;
}

export interface AgencyPolicyConfig extends AgencyPolicyBudget {
  mode: AgencyRuntimeMode;
  canaryChatIds: number[];
  failClosed: boolean;
}

export interface AgencyPolicyInput {
  scope: CognitiveScope;
  action: AgencyAction;
  risk?: AgencyRisk;
  budget?: AgencyPolicyBudget;
}

export interface AgencyPolicyDecision {
  mode: AgencyRuntimeMode;
  risk: AgencyRisk;
  allowed: boolean;
  /** True when the action is safe to keep as a proposal and retry later. */
  deferred: boolean;
  canaryEligible: boolean;
  reason?: string;
  config: AgencyPolicyConfig;
}

const DEFAULT_CONFIG: AgencyPolicyConfig = {
  mode: 'shadow',
  canaryChatIds: [],
  maxLlmCalls: 2,
  maxToolCalls: 8,
  failClosed: true,
};

function boundedNonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : fallback;
}

function normalizeChatIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => Number.isSafeInteger(id) && id !== 0))];
}

/** Read rollout configuration once per decision so tests and emergency changes can swap env. */
export function getAgencyPolicyConfig(): AgencyPolicyConfig {
  try {
    const current = env() as unknown as Record<string, unknown>;
    const mode = current['AGENCY_RUNTIME_MODE'];
    return {
      mode: mode === 'shadow' || mode === 'advisory' || mode === 'canary' || mode === 'authority'
        ? mode
        : DEFAULT_CONFIG.mode,
      canaryChatIds: normalizeChatIds(current['AGENCY_CANARY_CHAT_IDS']),
      maxLlmCalls: boundedNonNegative(current['AGENCY_MAX_LLM_CALLS'], DEFAULT_CONFIG.maxLlmCalls),
      maxToolCalls: boundedNonNegative(current['AGENCY_MAX_TOOL_CALLS'], DEFAULT_CONFIG.maxToolCalls),
      failClosed: current['AGENCY_FAIL_CLOSED'] !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG, canaryChatIds: [] };
  }
}

function actionRisk(action: AgencyAction): AgencyRisk {
  switch (action.type) {
    case 'observe':
      return 'read';
    case 'speak':
    case 'ask':
    case 'wait':
    case 'remember':
    case 'correct':
      return 'reversible';
    case 'act':
    case 'stop':
      return 'irreversible';
  }
}

function validScopedChat(scope: CognitiveScope): boolean {
  if (!scope || scope.visibility === 'global' || scope.chatId === undefined || scope.chatId === 0) return false;
  try {
    scopeKey(scope);
    return Number.isSafeInteger(scope.chatId);
  } catch {
    return false;
  }
}

/**
 * Decide whether a host may dispatch an action now.
 *
 * `shadow` and `advisory` are intentionally useful states: a proposal can be
 * persisted and inspected, while only read actions are executable in advisory.
 * `canary` requires an explicit chat allowlist and never permits irreversible
 * actions. `authority` is the only mode that permits the full action space.
 */
export function evaluateAgencyPolicy(input: AgencyPolicyInput): AgencyPolicyDecision {
  const config = getAgencyPolicyConfig();
  const derivedRisk = actionRisk(input.action);
  const risk = input.risk ?? derivedRisk;
  const canaryEligible = validScopedChat(input.scope)
    && config.canaryChatIds.includes(input.scope.chatId ?? 0);
  const base = {
    mode: config.mode,
    risk,
    canaryEligible,
    config,
  };

  // Risk is host-owned. A caller may provide it as a consistency assertion,
  // but can never downgrade an action (for example, label `act` as `read`).
  if (input.risk !== undefined && input.risk !== derivedRisk) {
    return { ...base, risk: derivedRisk, allowed: false, deferred: false, reason: 'risk_mismatch' };
  }

  if (!validScopedChat(input.scope)) {
    return { ...base, allowed: false, deferred: false, reason: 'scoped_chat_required' };
  }

  if (input.budget) {
    if (!Number.isSafeInteger(input.budget.maxLlmCalls) || input.budget.maxLlmCalls < 0
      || input.budget.maxLlmCalls > config.maxLlmCalls) {
      return { ...base, allowed: false, deferred: true, reason: 'llm_budget_exceeded' };
    }
    if (!Number.isSafeInteger(input.budget.maxToolCalls) || input.budget.maxToolCalls < 0
      || input.budget.maxToolCalls > config.maxToolCalls) {
      return { ...base, allowed: false, deferred: true, reason: 'tool_budget_exceeded' };
    }
  }

  if (config.mode === 'shadow') {
    return { ...base, allowed: false, deferred: true, reason: 'shadow_only' };
  }
  if (config.mode === 'advisory') {
    return risk === 'read'
      ? { ...base, allowed: true, deferred: false }
      : { ...base, allowed: false, deferred: true, reason: 'advisory_read_only' };
  }
  if (config.mode === 'canary') {
    if (!canaryEligible) return { ...base, allowed: false, deferred: true, reason: 'canary_chat_not_allowed' };
    if (risk === 'irreversible') {
      return { ...base, allowed: false, deferred: true, reason: 'canary_irreversible_blocked' };
    }
    return { ...base, allowed: true, deferred: false };
  }

  // Authority still requires a scoped chat. The explicit fail-closed flag is
  // carried in the decision for callers that need to reject unavailable host
  // capabilities before invoking an adapter.
  return { ...base, allowed: true, deferred: false };
}
