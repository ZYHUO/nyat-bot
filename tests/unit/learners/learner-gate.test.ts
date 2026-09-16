import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mutable lock store the mocked redis SET NX / DEL operate against, so we can
// simulate "another process already holds the lock".
const redisLocks = new Set<string>();
const mockSet = vi.fn(
  async (key: string, _val: string, _exFlag: string, _ttl: number, nxFlag: string) => {
    if (nxFlag === 'NX' && redisLocks.has(key)) return null;
    redisLocks.add(key);
    return 'OK';
  },
);
const mockDel = vi.fn(async (key: string) => {
  redisLocks.delete(key);
  return 1;
});

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ set: mockSet, del: mockDel }),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { acquireLearnerSlot, releaseLearnerSlot } = await import(
  '../../../src/learners/learner-gate.js'
);

describe('learner-gate', () => {
  beforeEach(() => {
    redisLocks.clear();
    mockSet.mockClear();
    mockDel.mockClear();
  });

  // The in-process Set is module-level state; release everything we touch.
  afterEach(async () => {
    for (const id of [-1, -2, -3, -4, -5]) {
      await releaseLearnerSlot(id);
    }
  });

  it('grants a slot and reports active count', async () => {
    const res = await acquireLearnerSlot(-1);
    expect(res.ok).toBe(true);
    expect(res.active).toBe(1);
    expect(mockSet).toHaveBeenCalledWith('xxb:learner:active:-1', '1', 'EX', expect.any(Number), 'NX');
  });

  it('blocks the 4th concurrent chat at the global cap of 3', async () => {
    expect((await acquireLearnerSlot(-1)).ok).toBe(true);
    expect((await acquireLearnerSlot(-2)).ok).toBe(true);
    expect((await acquireLearnerSlot(-3)).ok).toBe(true);

    const fourth = await acquireLearnerSlot(-4);
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe('global_cap');
    expect(fourth.active).toBe(3);
  });

  it('blocks re-acquiring the same chat that already holds a slot', async () => {
    expect((await acquireLearnerSlot(-1)).ok).toBe(true);

    const again = await acquireLearnerSlot(-1);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('already_active');
    expect(again.active).toBe(1);
  });

  it('frees the slot on release so it can be re-acquired', async () => {
    expect((await acquireLearnerSlot(-1)).ok).toBe(true);
    await releaseLearnerSlot(-1);
    expect(mockDel).toHaveBeenCalledWith('xxb:learner:active:-1');

    const reacquire = await acquireLearnerSlot(-1);
    expect(reacquire.ok).toBe(true);
    expect(reacquire.active).toBe(1);
  });

  it('release frees a slot at the cap, letting a waiting chat in', async () => {
    await acquireLearnerSlot(-1);
    await acquireLearnerSlot(-2);
    await acquireLearnerSlot(-3);
    expect((await acquireLearnerSlot(-4)).ok).toBe(false);

    await releaseLearnerSlot(-2);
    const now = await acquireLearnerSlot(-4);
    expect(now.ok).toBe(true);
    expect(now.active).toBe(3);
  });

  it('fails when the Redis NX lock is already held by another process', async () => {
    // Simulate another process holding the lock for chat -5.
    redisLocks.add('xxb:learner:active:-5');

    const res = await acquireLearnerSlot(-5);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('redis_locked');
  });
});
