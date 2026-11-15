import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisSet, redisGet, isCodeActBusy, getChatState, findConversationRef, config } = vi.hoisted(() => ({
  redisSet: vi.fn(async () => 'OK'),
  redisGet: vi.fn(async () => null),
  isCodeActBusy: vi.fn(async () => false),
  getChatState: vi.fn(async () => ({ lastBotReplyAt: 0 })),
  findConversationRef: vi.fn(),
  config: { META_HEART_REFRACTORY_MS: 45_000, META_QQ_HEART_REFRACTORY_MS: 0 },
}));

vi.mock('../../../src/env.js', () => ({
  env: () => config,
}));
vi.mock('../../../src/platform/identity-store.js', () => ({
  isPlatformInternalId: (id: number) => Math.abs(id) >= 2 ** 52,
  findConversationRef,
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ set: redisSet, get: redisGet }),
}));
vi.mock('../../../src/subagent/task-store.js', () => ({ isCodeActBusy }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState }));

import {
  armMetaHeartRefractory,
  shouldSuppressMetaHeartDispatch,
  shouldSuppressMetaHeartElevate,
} from '../../../src/meta/heart-refractory.js';

describe('heart-refractory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue('OK');
    redisGet.mockResolvedValue(null);
    isCodeActBusy.mockResolvedValue(false);
    getChatState.mockResolvedValue({ lastBotReplyAt: 0 });
    config.META_QQ_HEART_REFRACTORY_MS = 0;
    findConversationRef.mockReturnValue({ platform: 'qq', conversationKind: 'group' });
  });

  it('arm uses SET NX and second arm loses', async () => {
    expect(await armMetaHeartRefractory(-1001)).toBe(true);
    redisSet.mockResolvedValue(null);
    expect(await armMetaHeartRefractory(-1001)).toBe(false);
  });

  it('elevate suppresses when armed; dispatch does not', async () => {
    redisGet.mockResolvedValue(String(Date.now()));
    expect(await shouldSuppressMetaHeartElevate(-1001)).toBe(true);
    expect(await shouldSuppressMetaHeartDispatch(-1001)).toBe(false);
  });

  it('dispatch suppresses after recent bot reply', async () => {
    getChatState.mockResolvedValue({ lastBotReplyAt: Date.now() - 3_000 });
    expect(await shouldSuppressMetaHeartDispatch(-1001)).toBe(true);
  });

  const qq = -(2 ** 52 + 1);
  it('keeps the old arm TTL and recent-reply policy when the QQ override is off', async () => {
    await armMetaHeartRefractory(qq);
    expect(redisSet).toHaveBeenCalledWith(`xxb:meta:heart_arm:${qq}`, expect.any(String), 'EX', 50, 'NX');
    getChatState.mockResolvedValue({ lastBotReplyAt: Date.now() - 20_000 });
    expect(await shouldSuppressMetaHeartDispatch(qq)).toBe(true);
    expect(findConversationRef).not.toHaveBeenCalled();
  });

  it('uses the exact QQ override for its arm and text cooldown without changing Telegram', async () => {
    config.META_QQ_HEART_REFRACTORY_MS = 10_000;
    await armMetaHeartRefractory(qq); await armMetaHeartRefractory(-1001);
    expect(redisSet).toHaveBeenCalledWith(`xxb:meta:heart_arm:${qq}`, expect.any(String), 'PX', 10_000, 'NX');
    expect(redisSet).toHaveBeenCalledWith('xxb:meta:heart_arm:-1001', expect.any(String), 'EX', 50, 'NX');
    getChatState.mockResolvedValue({ lastBotReplyAt: Date.now() - 11_000 });
    expect(await shouldSuppressMetaHeartDispatch(qq)).toBe(false);
    expect(await shouldSuppressMetaHeartDispatch(-1001)).toBe(true);
    isCodeActBusy.mockResolvedValue(true);
    expect(await shouldSuppressMetaHeartDispatch(qq)).toBe(true);
  });

  it.each(['missing', 'error', 'private', 'other-platform'] as const)('does not shorten an unverifiable QQ group: %s', kind => {
    config.META_QQ_HEART_REFRACTORY_MS = 10_000;
    if (kind === 'missing') findConversationRef.mockReturnValue(null);
    if (kind === 'error') findConversationRef.mockImplementation(() => { throw new Error('fixture storage failure'); });
    if (kind === 'private') findConversationRef.mockReturnValue({ platform: 'qq', conversationKind: 'private' });
    if (kind === 'other-platform') findConversationRef.mockReturnValue({ platform: 'telegram', conversationKind: 'group' });
    getChatState.mockResolvedValue({ lastBotReplyAt: Date.now() - 11_000 });
    return expect(shouldSuppressMetaHeartDispatch(qq)).resolves.toBe(true);
  });
});
