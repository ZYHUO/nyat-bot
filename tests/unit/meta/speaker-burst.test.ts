import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisGet = vi.fn(async (): Promise<string | null> => null);
const redisSet = vi.fn(async (): Promise<string | null> => 'OK');
const redisDel = vi.fn(async () => 1);
const listTasks = vi.fn(() => [] as Array<{ status: string; targetUserId?: number; createdAt: number }>);

vi.mock('../../../src/env.js', () => ({
  env: () => ({ META_L0_COALESCE_MS: 2800 }),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet, del: redisDel }),
}));
vi.mock('../../../src/meta/global-state.js', () => ({
  getGlobalState: () => ({ listTasks }),
}));

import {
  clearSpeakerBurst,
  isInFlightCodeActForUser,
  isSpeakerBurstOpen,
  markSpeakerBurst,
  shouldForceSameSpeakerL0,
} from '../../../src/meta/speaker-burst.js';

describe('speaker-burst', () => {
  beforeEach(() => {
    redisGet.mockReset();
    redisSet.mockReset();
    redisDel.mockReset();
    listTasks.mockReset();
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
    redisDel.mockResolvedValue(1);
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

  it('shouldForceSameSpeakerL0 allows only one follow-up (NX)', async () => {
    listTasks.mockReturnValue([
      { status: 'queued', targetUserId: 7, createdAt: Date.now() },
    ]);
    redisSet.mockResolvedValueOnce('OK');
    expect(await shouldForceSameSpeakerL0(-1001, 7)).toBe(true);
    expect(redisSet).toHaveBeenCalledWith(
      'xxb:meta:speaker_burst_once:-1001',
      '7',
      'EX',
      180,
      'NX',
    );

    redisSet.mockResolvedValueOnce(null); // already claimed
    expect(await shouldForceSameSpeakerL0(-1001, 7)).toBe(false);
  });

  it('shouldForceSameSpeakerL0 false when no burst and no in-flight', async () => {
    expect(await shouldForceSameSpeakerL0(-1001, 8)).toBe(false);
  });

  it('clearSpeakerBurst deletes both keys (legacy, no uid)', async () => {
    await clearSpeakerBurst(-1001);
    expect(redisDel).toHaveBeenCalledWith(
      'xxb:meta:speaker_burst:-1001',
      'xxb:meta:speaker_burst_once:-1001',
    );
  });

  it('clearSpeakerBurst with uid only deletes keys owned by that uid (CAS)', async () => {
    // KEY owned by uid 42 → delete; ONCE_KEY owned by uid 99 → keep
    redisGet.mockImplementation(async (key: string) => {
      if (key === 'xxb:meta:speaker_burst:-1001') return '42';
      if (key === 'xxb:meta:speaker_burst_once:-1001') return '99';
      return null;
    });
    await clearSpeakerBurst(-1001, 42);
    // KEY should be deleted (owned by 42)
    expect(redisDel).toHaveBeenCalledWith('xxb:meta:speaker_burst:-1001');
    // ONCE_KEY should NOT be deleted (owned by 99, not 42) — check del was
    // only called once (for KEY), not for ONCE_KEY
    expect(redisDel).toHaveBeenCalledTimes(1);
  });

  it('clearSpeakerBurst with uid skips keys not owned by uid', async () => {
    redisGet.mockResolvedValue('99'); // both keys owned by 99
    await clearSpeakerBurst(-1001, 42);
    expect(redisDel).not.toHaveBeenCalled();
  });
});
