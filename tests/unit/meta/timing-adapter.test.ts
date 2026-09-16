import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTimingGate = vi.fn();
const isChatSuppressed = vi.fn(async () => false);
const transitionToWait = vi.fn(async () => undefined);
const transitionToRunning = vi.fn(async () => undefined);
const recordGateContinue = vi.fn(async () => undefined);
const recordUserMessage = vi.fn(async () => undefined);
const recordGateNoAction = vi.fn(async () => undefined);
const scheduleMetaDeferReeval = vi.fn(async () => true);

vi.mock('../../../src/pipeline/timing/gate.js', () => ({
  runTimingGate: (...args: unknown[]) => runTimingGate(...args),
}));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: vi.fn(async () => ({ state: 'RUNNING' })),
  isChatSuppressed: (...args: unknown[]) => isChatSuppressed(...args),
  recordGateContinue: (...args: unknown[]) => recordGateContinue(...args),
  recordBotReply: vi.fn(async () => undefined),
  recordUserMessage: (...args: unknown[]) => recordUserMessage(...args),
  transitionToWait: (...args: unknown[]) => transitionToWait(...args),
  transitionToRunning: (...args: unknown[]) => transitionToRunning(...args),
}));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({
  recordGateNoAction: (...args: unknown[]) => recordGateNoAction(...args),
}));
vi.mock('../../../src/meta/defer.js', () => ({
  scheduleMetaDeferReeval: (...args: unknown[]) => scheduleMetaDeferReeval(...args),
}));
vi.mock('../../../src/env.js', () => {
  const base = {
    TIMING_GATE_ENABLED: true,
    META_SUBAGENT_ENABLED: true,
    TIMING_WAIT_MIN_SEC: 5,
    META_DEFER_ENABLED: true,
    TURN_GATE_DEFER_MAX_REPLAYS: 1,
  };
  return { env: () => base };
});
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUid: () => 1,
  getBotDisplayName: () => '啾咪囝',
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
  }),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/shared/config.js', () => ({
  loadCachedPrompt: () => '',
}));

describe('evaluateMetaTiming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isChatSuppressed.mockResolvedValue(false);
    scheduleMetaDeferReeval.mockResolvedValue(true);
  });

  const fm = {
    role: 'user' as const,
    uid: 1,
    username: 'u',
    fullName: 'U',
    timestamp: 1,
    messageId: 9,
    textContent: '旁观闲聊',
    isForwarded: false,
  };

  it('allows L0 without calling gate LLM path meaningfully (direct bypass)', async () => {
    const { evaluateMetaTiming } = await import('../../../src/meta/timing-adapter.js');
    const r = await evaluateMetaTiming({
      chatId: -1001,
      formatted: fm,
      isDirect: true,
      layer: 'L0',
    });
    expect(r.verdict).toBe('allow');
    expect(runTimingGate).not.toHaveBeenCalled();
  });

  it('silences L2 on no_action (non-defer)', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'no_action',
      reason: 'quiet',
      shortCircuited: false,
      latencyMs: 1,
    });
    const { evaluateMetaTiming } = await import('../../../src/meta/timing-adapter.js');
    const r = await evaluateMetaTiming({
      chatId: -1001,
      formatted: fm,
      isDirect: false,
      layer: 'L2',
    });
    expect(r.verdict).toBe('silence');
    expect(recordGateNoAction).toHaveBeenCalled();
    expect(scheduleMetaDeferReeval).not.toHaveBeenCalled();
  });

  it('waits L1 and transitions to WAIT', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'wait',
      waitSec: 12,
      reason: 'burst',
      shortCircuited: false,
      latencyMs: 1,
    });
    const { evaluateMetaTiming } = await import('../../../src/meta/timing-adapter.js');
    const r = await evaluateMetaTiming({
      chatId: -1001,
      formatted: fm,
      isDirect: false,
      layer: 'L1',
    });
    expect(r.verdict).toBe('silence');
    expect(transitionToWait).toHaveBeenCalled();
  });

  it('passes canDefer=true to gate when META_DEFER_ENABLED', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'continue',
      reason: 'continuation_window',
      shortCircuited: true,
      latencyMs: 1,
      continuation: true,
    });
    const { evaluateMetaTiming } = await import('../../../src/meta/timing-adapter.js');
    await evaluateMetaTiming({
      chatId: -1001,
      formatted: fm,
      isDirect: false,
      layer: 'L1',
    });
    const gateArgs = runTimingGate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(gateArgs).toBeTruthy();
    expect(gateArgs['canDefer']).toBe(true);
  });

  it('defers on deferOnly decision and schedules re-eval', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'no_action',
      reason: 'cooldown_defer',
      shortCircuited: true,
      latencyMs: 1,
      deferOnly: true,
      retryAfterMs: 15_000,
    });
    const { evaluateMetaTiming } = await import('../../../src/meta/timing-adapter.js');
    const r = await evaluateMetaTiming({
      chatId: -1001,
      formatted: fm,
      isDirect: false,
      layer: 'L1',
    });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toContain('defer:');
    expect(scheduleMetaDeferReeval).toHaveBeenCalledTimes(1);
    expect(recordGateNoAction).not.toHaveBeenCalled();
  });

  it('fail-open allows on deferOnly when schedule fails (budget exhausted)', async () => {
    runTimingGate.mockResolvedValueOnce({
      action: 'no_action',
      reason: 'talk_value_below_threshold',
      shortCircuited: true,
      latencyMs: 1,
      deferOnly: true,
      retryAfterMs: 30_000,
    });
    scheduleMetaDeferReeval.mockResolvedValueOnce(false);
    const { evaluateMetaTiming } = await import('../../../src/meta/timing-adapter.js');
    const r = await evaluateMetaTiming({
      chatId: -1001,
      formatted: fm,
      isDirect: false,
      layer: 'L2',
    });
    expect(r.verdict).toBe('allow');
    expect(r.reason).toContain('defer_exhausted:');
  });
});
