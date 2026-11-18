import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ timingEnabled: true }));
const {
  heartDecision,
  composeSelfState,
  computeEngagement,
  getRecent,
  getChatState,
  getGateCooldownRemainingMs,
  isInContinuation,
  transitionToWait,
  recordGateNoAction,
  redisSet,
  redisGet,
  isCodeActBusy,
} = vi.hoisted(() => ({
  heartDecision: vi.fn(),
  composeSelfState: vi.fn(async () => ({ narration: '在发呆' })),
  computeEngagement: vi.fn(() => ({ budget: 0.8, note: null, factors: [] as string[] })),
  getRecent: vi.fn(async () => [] as unknown[]),
  getChatState: vi.fn(async () => ({ lastBotReplyAt: 0 })),
  getGateCooldownRemainingMs: vi.fn(async () => 0),
  isInContinuation: vi.fn(() => false),
  transitionToWait: vi.fn(async () => {}),
  recordGateNoAction: vi.fn(async () => {}),
  redisSet: vi.fn(async () => 'OK'),
  redisGet: vi.fn(async () => null),
  isCodeActBusy: vi.fn(async () => false),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    HEART_ENABLED: true,
    TIMING_GATE_ENABLED: settings.timingEnabled,
    TIMING_WAIT_MIN_SEC: 8,
    TIMING_GATE_TIMEOUT_MS: 8000,
    META_HEART_REFRACTORY_MS: 45_000,
  }),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotDisplayName: () => '啾咪囝',
  getBotUid: () => 1,
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ reactToMessage: vi.fn() }));
vi.mock('../../../src/pipeline/heart/decision.js', () => ({ heartDecision }));
vi.mock('../../../src/pipeline/heart/self-state.js', () => ({ composeSelfState }));
const isBotMonologueTrail = vi.fn(() => false);
vi.mock('../../../src/pipeline/heart/engagement.js', () => ({
  computeEngagement,
  HARD_PASS_BUDGET: 0.12,
  isBotMonologueTrail: (...args: unknown[]) => isBotMonologueTrail(...args),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState,
  getGateCooldownRemainingMs,
  isInContinuation,
  transitionToWait,
}));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({ recordGateNoAction }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    set: redisSet,
    get: redisGet,
  }),
}));
vi.mock('../../../src/meta/timing-adapter.js', () => ({
  setMetaWaitAnchor: async (anchor: unknown, ttl: number) => { await redisSet('wait-key', JSON.stringify(anchor), 'EX', ttl); return 'test-generation'; },
}));
vi.mock('../../../src/agent/agency-wait-dispatch.js', () => ({ dispatchWaitViaAgency: vi.fn(async () => ({ attempted: false })) }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  isCodeActBusy,
}));

import { evaluateMetaHeart } from '../../../src/meta/heart-adapter.js';

const fm = {
  role: 'user' as const,
  uid: 42,
  username: 'u',
  fullName: 'User',
  timestamp: Math.floor(Date.now() / 1000),
  messageId: 99,
  textContent: '今天天气真好',
  isForwarded: false,
};

describe('evaluateMetaHeart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.timingEnabled = true;
    computeEngagement.mockReturnValue({ budget: 0.8, note: null, factors: [] });
    isBotMonologueTrail.mockReturnValue(false);
    getGateCooldownRemainingMs.mockResolvedValue(0);
    isInContinuation.mockReturnValue(false);
    isCodeActBusy.mockResolvedValue(false);
    getChatState.mockResolvedValue({ lastBotReplyAt: 0 });
    redisSet.mockResolvedValue('OK');
    redisGet.mockResolvedValue(null);
  });

  it('reply → allow L1 with heart: reason', async () => {
    heartDecision.mockResolvedValue({
      act: 'reply',
      path: 'chat',
      why: '接一下天气',
      latencyMs: 10,
      judgeResult: { action: 'REPLY', level: 'L2_AI', rule: 'heart', latencyMs: 10 },
    });
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('allow');
    expect(r.layer).toBe('L1');
    expect(r.reason).toMatch(/^heart:/);
  });

  it('pass → silence and record no_action', async () => {
    heartDecision.mockResolvedValue({
      act: 'pass',
      path: 'chat',
      why: '不关我事',
      latencyMs: 5,
      judgeResult: { action: 'IGNORE', level: 'L2_AI', rule: 'heart', latencyMs: 5 },
    });
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(recordGateNoAction).toHaveBeenCalled();
  });

  it('engagement hard-pass skips heart LLM', async () => {
    computeEngagement.mockReturnValue({ budget: 0.05, note: null, factors: ['share'] });
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_engagement');
    expect(heartDecision).not.toHaveBeenCalled();
  });

  it('bot monologue trail → silence even when engagement would allow', async () => {
    isBotMonologueTrail.mockReturnValue(true);
    computeEngagement.mockReturnValue({ budget: 0.9, note: null, factors: [] });
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_bot_monologue');
    expect(heartDecision).not.toHaveBeenCalled();
  });

  it('CodeAct busy → silence without LLM', async () => {
    isCodeActBusy.mockResolvedValue(true);
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_busy');
    expect(heartDecision).not.toHaveBeenCalled();
  });

  it('recent bot reply → refractory silence', async () => {
    getChatState.mockResolvedValue({ lastBotReplyAt: Date.now() - 5_000 });
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_refractory');
    expect(heartDecision).not.toHaveBeenCalled();
  });

  it('armed heart → refractory silence without LLM', async () => {
    redisGet.mockResolvedValue(String(Date.now()));
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_refractory');
    expect(heartDecision).not.toHaveBeenCalled();
  });

  it('lost NX arm race after LLM → silence', async () => {
    heartDecision.mockResolvedValue({
      act: 'reply',
      path: 'chat',
      why: '接一下',
      latencyMs: 10,
      judgeResult: { action: 'REPLY', level: 'L2_AI', rule: 'heart', latencyMs: 10 },
    });
    redisSet.mockResolvedValue(null); // NX lost
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_refractory');
  });

  it('wait setup failure stays silent', async () => {
    heartDecision.mockResolvedValue({
      act: 'wait',
      path: 'chat',
      why: '等TA说完',
      latencyMs: 10,
      judgeResult: { action: 'IGNORE', level: 'L2_AI', rule: 'heart', latencyMs: 10 },
    });
    // Anchor set succeeds, but transitionToWait fails
    redisSet.mockResolvedValue('OK');
    transitionToWait.mockRejectedValueOnce(new Error('BullMQ down'));
    const r = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L2' });
    expect(r.verdict).toBe('silence');
    expect(r.reason).toBe('heart_wait_setup_failed');
  });
  it('expiry wait is silent and never schedules another generation', async () => {
    heartDecision.mockResolvedValue({ act: 'wait', why: 'still busy', latencyMs: 1 });
    const result = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L1', waitResume: true });
    expect(result.reason).toBe('heart_wait_expired_still_waiting');
    expect(transitionToWait).not.toHaveBeenCalled();
  });
  it('rejects a reply invalidated during the model call before any arm', async () => {
    let current = true;
    heartDecision.mockImplementationOnce(async () => { current = false; return { act: 'reply', why: 'reply', latencyMs: 1 }; });
    const result = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L1', isCurrent: async () => current });
    expect(result.verdict).toBe('silence');
    expect(redisSet).not.toHaveBeenCalled();
  });
  it('effect ownership refusal prevents wait persistence', async () => {
    heartDecision.mockResolvedValue({ act: 'wait', why: 'busy', latencyMs: 1 });
    const result = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L1', beforeEffect: async () => false });
    expect(result.verdict).toBe('silence'); expect(redisSet).not.toHaveBeenCalled();
    expect(transitionToWait).not.toHaveBeenCalled();
  });
  it('forwards only host candidate IDs and returns the selected targets', async () => {
    heartDecision.mockResolvedValue({ act: 'reply', why: 'reply', latencyMs: 1, targetMessageIds: [99] });
    const result = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L1', batchMessages: [fm], targetMessageIds: [99] });
    expect(heartDecision).toHaveBeenCalledWith(expect.objectContaining({ batchMessages: [fm], targetMessageIds: [99] }));
    expect(result.targetMessageIds).toEqual([99]);
  });

  it('does not turn wait into speech or an anchor without an enabled timer', async () => {
    settings.timingEnabled = false;
    heartDecision.mockResolvedValue({ act: 'wait', why: 'wait', latencyMs: 1 });
    const result = await evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L1' });
    expect(result).toMatchObject({ verdict: 'silence', reason: 'heart_wait_transport_unavailable' });
    expect(redisSet).not.toHaveBeenCalled(); expect(transitionToWait).not.toHaveBeenCalled();
  });

  it.each(['reply', 'wait', 'react'])('surfaces host authority read errors before %s side effects', async act => {
    heartDecision.mockResolvedValue({ act, emoji: '👍', why: 'fixture', latencyMs: 1 });
    const beforeEffect = async () => { throw Error('authority_unavailable'); };
    await expect(evaluateMetaHeart({ chatId: -1001, formatted: fm, layer: 'L1', beforeEffect })).rejects.toThrow('authority_unavailable');
    expect(redisSet).not.toHaveBeenCalled(); expect(transitionToWait).not.toHaveBeenCalled();
  });

});
