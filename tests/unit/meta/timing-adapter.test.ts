import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTimingGate = vi.fn();
const isChatSuppressed = vi.fn(async () => false);
const transitionToWait = vi.fn(async () => undefined);
const transitionToRunning = vi.fn(async () => undefined);
const recordGateContinue = vi.fn(async () => undefined);
const recordUserMessage = vi.fn(async () => undefined);
const recordGateNoAction = vi.fn(async () => undefined);

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
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    TIMING_GATE_ENABLED: true,
    META_SUBAGENT_ENABLED: true,
    TIMING_WAIT_MIN_SEC: 5,
  }),
}));
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

  it('silences L2 on no_action', async () => {
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
});
