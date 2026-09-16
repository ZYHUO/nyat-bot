import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisSet, redisGet, isCodeActBusy, getChatState } = vi.hoisted(() => ({
  redisSet: vi.fn(async () => 'OK'),
  redisGet: vi.fn(async () => null),
  isCodeActBusy: vi.fn(async () => false),
  getChatState: vi.fn(async () => ({ lastBotReplyAt: 0 })),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ META_HEART_REFRACTORY_MS: 45_000 }),
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
});
