import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('wait setup failure → fail-open allow (not silence)', async () => {
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
    expect(r.verdict).toBe('allow');
    expect(r.reason).toBe('heart_wait_setup_failed');
  });
});
