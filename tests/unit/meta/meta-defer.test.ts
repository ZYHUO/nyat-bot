import { beforeEach, describe, expect, it, vi } from 'vitest';

const zadd = vi.fn(async () => 1);
const evalMock = vi.fn(async (_script: string, _n: number, _key: string) => [] as string[]);

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    zadd,
    eval: evalMock,
  }),
}));

const envValues: Record<string, unknown> = {
  TURN_GATE_DEFER_MAX_REPLAYS: 2,
};

vi.mock('../../../src/env.js', () => ({
  env: () => envValues,
}));

describe('meta defer (Redis ZSET)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    zadd.mockResolvedValue(1);
  });

  describe('hasMetaDeferBudget', () => {
    it('returns true when under budget', async () => {
      const { hasMetaDeferBudget } = await import('../../../src/meta/defer.js');
      expect(hasMetaDeferBudget(0)).toBe(true);
      expect(hasMetaDeferBudget(1)).toBe(true);
    });

    it('returns false when budget exhausted', async () => {
      const { hasMetaDeferBudget } = await import('../../../src/meta/defer.js');
      expect(hasMetaDeferBudget(2)).toBe(false);
      expect(hasMetaDeferBudget(undefined)).toBe(true);
    });
  });

  describe('scheduleMetaDeferReeval', () => {
    it('zadds to Redis sorted set with fire-at score', async () => {
      const { scheduleMetaDeferReeval } = await import('../../../src/meta/defer.js');
      const r = await scheduleMetaDeferReeval({
        chatId: -1001,
        entry: {
          chatId: -1001,
          layer: 'L1',
          reason: 'cooldown_defer',
          messageId: 42,
          userId: 7,
          textPreview: 'hello',
          pressure: 60,
        },
        deferCount: 0,
        retryAfterMs: 10_000,
        reason: 'cooldown_defer',
      });
      expect(r).toBe(true);
      expect(zadd).toHaveBeenCalledTimes(1);
      const [, score, member] = zadd.mock.calls[0]!;
      expect(score).toBeGreaterThan(Date.now() + 5_000);
      const parsed = JSON.parse(member as string);
      expect(parsed.chatId).toBe(-1001);
      expect(parsed.deferCount).toBe(1);
      expect(parsed.reason).toBe('cooldown_defer');
    });

    it('returns false when budget exhausted', async () => {
      const { scheduleMetaDeferReeval } = await import('../../../src/meta/defer.js');
      const r = await scheduleMetaDeferReeval({
        chatId: -1001,
        entry: {
          chatId: -1001,
          layer: 'L1',
          reason: 'cooldown_defer',
        },
        deferCount: 2,
        retryAfterMs: 10_000,
        reason: 'cooldown_defer',
      });
      expect(r).toBe(false);
      expect(zadd).not.toHaveBeenCalled();
    });

    it('clamps delay to minimum 3s', async () => {
      const { scheduleMetaDeferReeval } = await import('../../../src/meta/defer.js');
      await scheduleMetaDeferReeval({
        chatId: -1001,
        entry: { chatId: -1001, layer: 'L1', reason: 'test' },
        deferCount: 0,
        retryAfterMs: 100,
        reason: 'test',
      });
      const [, score] = zadd.mock.calls[0]!;
      expect(score).toBeGreaterThanOrEqual(Date.now() + 2_900);
    });
  });

  describe('drainDueMetaDefers', () => {
    it('returns parsed entries from eval', async () => {
      const entries = [
        JSON.stringify({
          chatId: -1001,
          layer: 'L1',
          reason: 'cooldown_defer',
          messageId: 42,
          deferCount: 1,
          originalCreatedAt: Date.now(),
        }),
      ];
      evalMock.mockResolvedValueOnce(entries);
      const { drainDueMetaDefers } = await import('../../../src/meta/defer.js');
      const out = await drainDueMetaDefers();
      expect(out).toHaveLength(1);
      expect(out[0]!.chatId).toBe(-1001);
      expect(out[0]!.deferCount).toBe(1);
    });

    it('returns empty array when no due items', async () => {
      evalMock.mockResolvedValueOnce([]);
      const { drainDueMetaDefers } = await import('../../../src/meta/defer.js');
      const out = await drainDueMetaDefers();
      expect(out).toEqual([]);
    });

    it('drops malformed entries', async () => {
      evalMock.mockResolvedValueOnce(['not json', JSON.stringify({ chatId: -1, layer: 'L1', reason: 'r', deferCount: 1, originalCreatedAt: 1 })]);
      const { drainDueMetaDefers } = await import('../../../src/meta/defer.js');
      const out = await drainDueMetaDefers();
      expect(out).toHaveLength(1);
      expect(out[0]!.chatId).toBe(-1);
    });
  });
});
