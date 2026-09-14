import { describe, expect, it, vi } from 'vitest';

const envState: Record<string, unknown> = {
  AGENCY_RUNTIME_MODE: 'shadow',
  AGENCY_CANARY_CHAT_IDS: [],
  AGENCY_MAX_LLM_CALLS: 2,
  AGENCY_MAX_TOOL_CALLS: 8,
  AGENCY_FAIL_CLOSED: true,
};

vi.mock('../../../src/env.js', () => ({ env: () => envState }));

import { evaluateAgencyPolicy, getAgencyPolicyConfig } from '../../../src/agent/agency-policy.js';

describe('agency rollout policy', () => {
  it('keeps shadow proposals non-dispatchable', () => {
    envState.AGENCY_RUNTIME_MODE = 'shadow';
    const decision = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'speak', text: 'hello' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deferred).toBe(true);
    expect(decision.reason).toBe('shadow_only');
  });

  it('allows only read actions in advisory mode', () => {
    envState.AGENCY_RUNTIME_MODE = 'advisory';
    const read = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'observe', target: 'recent messages' },
    });
    const speak = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'speak', text: 'hello' },
    });
    expect(read.allowed).toBe(true);
    expect(speak.allowed).toBe(false);
    expect(speak.reason).toBe('advisory_read_only');
  });

  it('requires the canary chat and blocks irreversible actions', () => {
    envState.AGENCY_RUNTIME_MODE = 'canary';
    envState.AGENCY_CANARY_CHAT_IDS = [-100];
    const allowed = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'speak', text: 'hello' },
    });
    const wrongChat = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -200 },
      action: { type: 'speak', text: 'hello' },
    });
    const irreversible = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'act', goal: 'write a file' },
    });
    expect(allowed.allowed).toBe(true);
    expect(wrongChat.reason).toBe('canary_chat_not_allowed');
    expect(irreversible.reason).toBe('canary_irreversible_blocked');
  });

  it('rejects envelopes above host budgets and invalid global scope', () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    envState.AGENCY_MAX_LLM_CALLS = 1;
    const budget = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'observe', target: 'status' },
      budget: { maxLlmCalls: 2, maxToolCalls: 0 },
    });
    const global = evaluateAgencyPolicy({
      scope: { visibility: 'global' },
      action: { type: 'observe', target: 'status' },
    });
    expect(budget.reason).toBe('llm_budget_exceeded');
    expect(global.reason).toBe('scoped_chat_required');
  });

  it('recomputes action risk instead of trusting a caller downgrade', () => {
    envState.AGENCY_RUNTIME_MODE = 'authority';
    const decision = evaluateAgencyPolicy({
      scope: { visibility: 'chat', chatId: -100 },
      action: { type: 'act', goal: 'write a file' },
      risk: 'read',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.deferred).toBe(false);
    expect(decision.risk).toBe('irreversible');
    expect(decision.reason).toBe('risk_mismatch');
  });

  it('falls back to safe defaults for malformed values', () => {
    envState.AGENCY_RUNTIME_MODE = 'oops';
    envState.AGENCY_CANARY_CHAT_IDS = 'not-an-array';
    envState.AGENCY_MAX_LLM_CALLS = -1;
    const config = getAgencyPolicyConfig();
    expect(config.mode).toBe('shadow');
    expect(config.canaryChatIds).toEqual([]);
    expect(config.maxLlmCalls).toBe(2);
  });
});
