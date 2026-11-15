import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisStore = new Map<string, string>();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    set: vi.fn(async (k: string, v: string) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    expire: vi.fn(async () => 1),
  }),
}));

/**
 * markMessageAnswered 对「同一次回答」不能记两个戳（round 132）。
 *
 * 生产实测：`xxb:meta:answered:-1003350411234:68491` =
 *   1790169018,1790169058,1790169058,1790169094
 *                                  ^^^^^^^^^ 同一秒两个戳
 * 而那个锚点当时只成功发过一条消息。
 *
 * 查调用点发现同一次发送会标两遍：
 *   - src/bot/sender/telegram.ts:410（sendMessage 是公共出口，发完就标）
 *   - src/subagent/host-api.ts:1511（同一个 firstReplyTo，Meta 路径再标一遍）
 *
 * 后果：answeredTimestamps 多数一次 → 重复锚点闸（REPEAT_ANCHOR_MAX=2）
 * 在一次回答后就认为 recent=2，把本该允许的第二次也拦掉。
 * 设计意图是「拦第 N+1 次」，实际变成「拦第 2 次」。
 */
describe('answered bookkeeping dedupe', () => {
  beforeEach(() => {
    redisStore.clear();
    vi.useRealTimers();
  });

  it('same answer marked twice must record one stamp', async () => {
    const { markMessageAnswered, answeredTimestamps } = await import(
      '../../../src/meta/answered.js'
    );
    await markMessageAnswered(1_900_001, 424_242);
    await markMessageAnswered(1_900_001, 424_242); // telegram.ts + host-api.ts, one send
    expect(await answeredTimestamps(1_900_001, 424_242)).toHaveLength(1);
  });

  it('a genuinely later answer must still record', async () => {
    const { markMessageAnswered, answeredTimestamps } = await import(
      '../../../src/meta/answered.js'
    );
    await markMessageAnswered(1_900_002, 424_243);
    const t0 = Date.now();
    vi.setSystemTime(new Date(t0 + 5000));
    await markMessageAnswered(1_900_002, 424_243);
    vi.useRealTimers();
    const ts = await answeredTimestamps(1_900_002, 424_243);
    expect(ts).toHaveLength(2);
    expect(ts[0]! - ts[1]!).toBe(5);
  });

  it('one second apart must still record both', async () => {
    const { markMessageAnswered, answeredTimestamps } = await import(
      '../../../src/meta/answered.js'
    );
    await markMessageAnswered(1_900_003, 424_244);
    const t0 = Date.now();
    vi.setSystemTime(new Date(t0 + 1000));
    await markMessageAnswered(1_900_003, 424_244);
    vi.useRealTimers();
    expect(await answeredTimestamps(1_900_003, 424_244)).toHaveLength(2);
  });
});
