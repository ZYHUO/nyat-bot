import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisStore = new Map<string, string>();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    set: vi.fn(async (k: string, v: string) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
  }),
}));

describe('meta answered markers', () => {
  beforeEach(() => {
    redisStore.clear();
  });

  it('marks and detects answered quotes', async () => {
    const { markMessageAnswered, isMessageAnswered, allQuotesAnswered } = await import(
      '../../../src/meta/answered.js'
    );
    expect(await isMessageAnswered(1, 99)).toBe(false);
    await markMessageAnswered(1, 99);
    expect(await isMessageAnswered(1, 99)).toBe(true);
    expect(await allQuotesAnswered(1, [99])).toBe(true);
    expect(await allQuotesAnswered(1, [99, 100])).toBe(false);
  });
});
