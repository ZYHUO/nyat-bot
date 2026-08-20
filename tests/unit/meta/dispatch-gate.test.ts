import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTimingGate = vi.fn();
const recordGateContinue = vi.fn(async () => undefined);
const transitionToWait = vi.fn(async () => undefined);
const recordGateNoAction = vi.fn(async () => undefined);
const scheduleMetaDeferReeval = vi.fn(async () => true);
const setMetaWaitAnchor = vi.fn(async () => undefined);
const markMessageAnswered = vi.fn(async () => undefined);

vi.mock('../../../src/pipeline/timing/gate.js', () => ({
  runTimingGate: (...args: unknown[]) => runTimingGate(...args),
}));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: vi.fn(async () => ({ state: 'RUNNING' })),
  recordGateContinue: (...args: unknown[]) => recordGateContinue(...args),
  transitionToWait: (...args: unknown[]) => transitionToWait(...args),
}));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({
  recordGateNoAction: (...args: unknown[]) => recordGateNoAction(...args),
}));
vi.mock('../../../src/meta/timing-adapter.js', () => ({
  setMetaWaitAnchor: (...args: unknown[]) => setMetaWaitAnchor(...args),
}));
vi.mock('../../../src/meta/defer.js', () => ({
  scheduleMetaDeferReeval: (...args: unknown[]) => scheduleMetaDeferReeval(...args),
}));
vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: (...args: unknown[]) => markMessageAnswered(...args),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 1,
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => '',
}));

const envBase = {
  TIMING_GATE_ENABLED: true,
  META_DISPATCH_GATE_ENABLED: true,
  META_DEFER_ENABLED: true,
  TIMING_WAIT_MIN_SEC: 5,
};
vi.mock('../../../src/env.js', () => ({ env: () => envBase }));

describe('evaluateDispatchGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envBase.TIMING_GATE_ENABLED = true;
    envBase.META_DISPATCH_GATE_ENABLED = true;
    envBase.META_DEFER_ENABLED = true;
    scheduleMetaDeferReeval.mockResolvedValue(true);
  });

  const base = {
    chatId: -1001,
    layer: 'L1' as const,
    reason: 'heart:想插话',
    messageId: 9,
    userId: 42,
    textPreview: '群里在聊猫',
  };

  it('flag off → allow without calling gate', async () => {
    envBase.META_DISPATCH_GATE_ENABLED = false;
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('allow');
    expect(r.reason).toBe('dispatch_gate_disabled');
    expect(runTimingGate).not.toHaveBeenCalled();
  });

  it('L0 direct bypasses without calling gate', async () => {
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate({ ...base, layer: 'L0', reason: 'direct:mention' });
    expect(r.verdict).toBe('allow');
    expect(r.reason).toBe('l0_direct_bypass');
    expect(runTimingGate).not.toHaveBeenCalled();
  });

  it('L1_CALLBACK bypasses without calling gate', async () => {
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate({ ...base, layer: 'L1_CALLBACK', reason: 'callback:ok' });
    expect(r.verdict).toBe('allow');
    expect(r.reason).toBe('callback_bypass');
    expect(runTimingGate).not.toHaveBeenCalled();
  });

  it('continue → allow + recordGateContinue', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'continue',
      reason: 'ok',
      shortCircuited: false,
      latencyMs: 1,
    });
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('allow');
    expect(recordGateContinue).toHaveBeenCalledWith(-1001);
  });

  it('continuation short-circuit → allow but does NOT refresh the window', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'continue',
      reason: 'continuation_window',
      shortCircuited: true,
      continuation: true,
      latencyMs: 0,
    });
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('allow');
    expect(recordGateContinue).not.toHaveBeenCalled();
  });

  it('wait → suppress + anchor + transitionToWait', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'wait',
      waitSec: 20,
      reason: '二人密聊',
      shortCircuited: false,
      latencyMs: 1,
    });
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('suppress');
    expect(r.reason).toBe('wait:二人密聊');
    expect(setMetaWaitAnchor).toHaveBeenCalled();
    expect(transitionToWait).toHaveBeenCalledWith(-1001, 20, 9, 42);
    expect(markMessageAnswered).not.toHaveBeenCalled();
  });

  it('deferOnly no_action → scheduleMetaDeferReeval + suppress', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'no_action',
      reason: 'cooldown_defer',
      shortCircuited: true,
      latencyMs: 0,
      deferOnly: true,
      retryAfterMs: 30_000,
    });
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('suppress');
    expect(r.reason).toBe('defer:cooldown_defer');
    expect(scheduleMetaDeferReeval).toHaveBeenCalled();
    expect(recordGateNoAction).not.toHaveBeenCalled();
  });

  it('defer budget exhausted → fail-open allow', async () => {
    scheduleMetaDeferReeval.mockResolvedValueOnce(false);
    runTimingGate.mockResolvedValueOnce({
      action: 'no_action',
      reason: 'cooldown_defer',
      shortCircuited: true,
      latencyMs: 0,
      deferOnly: true,
      retryAfterMs: 30_000,
    });
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('allow');
    expect(r.reason).toBe('defer_exhausted:cooldown_defer');
  });

  it('real no_action → suppress + recordGateNoAction + mark answered', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'no_action',
      reason: '话题与我无关',
      shortCircuited: false,
      latencyMs: 1,
    });
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('suppress');
    expect(r.reason).toBe('no_action:话题与我无关');
    expect(recordGateNoAction).toHaveBeenCalledWith(-1001, 42);
    expect(markMessageAnswered).toHaveBeenCalledWith(-1001, 9);
  });

  it('gate LLM infra failure → fail-open allow', async () => {
    runTimingGate.mockRejectedValueOnce(new Error('provider down'));
    const { evaluateDispatchGate } = await import('../../../src/meta/dispatch-gate.js');
    const r = await evaluateDispatchGate(base);
    expect(r.verdict).toBe('allow');
    expect(r.reason).toBe('gate_error_failopen');
  });
});
