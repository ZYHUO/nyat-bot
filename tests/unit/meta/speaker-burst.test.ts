import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisGet = vi.fn(async (): Promise<string | null> => null);
const redisSet = vi.fn(async () => 'OK');
const listTasks = vi.fn(() => [] as Array<{ status: string; targetUserId?: number; createdAt: number }>);

vi.mock('../../../src/env.js', () => ({
  env: () => ({ META_L0_COALESCE_MS: 2800 }),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet }),
}));
vi.mock('../../../src/meta/global-state.js', () => ({
  getGlobalState: () => ({ listTasks }),
}));

import {
  isInFlightCodeActForUser,
  isSpeakerBurstOpen,
  markSpeakerBurst,
  shouldForceSameSpeakerL0,
} from '../../../src/meta/speaker-burst.js';

describe('speaker-burst', () => {
  beforeEach(() => {
    redisGet.mockReset();
    redisSet.mockReset();
    listTasks.mockReset();
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    listTasks.mockReturnValue([]);
  });

  it('markSpeakerBurst stores uid with coalesce-based TTL', async () => {
    await markSpeakerBurst(-1001, 6251541967);
    expect(redisSet).toHaveBeenCalledWith(
      'xxb:meta:speaker_burst:-1001',
      '6251541967',
      'EX',
      8,
    );
  });

  it('isSpeakerBurstOpen matches uid', async () => {
    redisGet.mockResolvedValue('42');
    expect(await isSpeakerBurstOpen(-1001, 42)).toBe(true);
    expect(await isSpeakerBurstOpen(-1001, 99)).toBe(false);
  });

  it('isInFlightCodeActForUser detects running task for uid', () => {
    listTasks.mockReturnValue([
      { status: 'running', targetUserId: 42, createdAt: Date.now() },
    ]);
    expect(isInFlightCodeActForUser(-1001, 42)).toBe(true);
    expect(isInFlightCodeActForUser(-1001, 99)).toBe(false);
  });

  it('shouldForceSameSpeakerL0 when burst open or in-flight', async () => {
    redisGet.mockResolvedValue('42');
    expect(await shouldForceSameSpeakerL0(-1001, 42)).toBe(true);

    redisGet.mockResolvedValue(null);
    listTasks.mockReturnValue([
      { status: 'queued', targetUserId: 7, createdAt: Date.now() },
    ]);
    expect(await shouldForceSameSpeakerL0(-1001, 7)).toBe(true);
    expect(await shouldForceSameSpeakerL0(-1001, 8)).toBe(false);
  });
});
