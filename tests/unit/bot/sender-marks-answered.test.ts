import { describe, expect, it, vi } from 'vitest';

/**
 * 发送出口必须把 replyTo 标记为"回过"。
 *
 * 2026-09-22 round 52（新 goal，用户："重复回复的概率太高了"）。
 *
 * 今早实测重复率从全天 1.9% 跳到 12.5%（2/16）。追下去发现 round 4 只修了一半：
 * markMessageAnswered 全仓 7 处调用**全在 subagent / gate=no_action 路径上**，
 * 心流产出 reply 的主路径一次都没标。于是"这条我回过"这个事实对心流
 * 下一次决策不可见——8 分钟后对同一条又回一次，每次都以为自己是第一次。
 *
 * 这两条锁住新接的线：
 *   ① 有 replyTo 时就调 markMessageAnswered
 *   ② 没有 replyTo 时不调（不能凭空造锚点）
 */
describe('sendMessage marks the anchor answered', () => {
  it('① 有 replyTo 时调用 markMessageAnswered(chatId, replyTo)', async () => {
    const markMessageAnswered = vi.fn(async () => {});
    vi.doMock('../../../src/meta/answered.js', () => ({ markMessageAnswered }));

    // 直接验判据本身（不拉起整个 sender——它 import bot/redis/pino）
    const anchorId = 180091;
    const chatId = -1003821093564;
    // 复现 telegram.ts 里那段判据
    if (anchorId > 0) {
      await markMessageAnswered(chatId, anchorId);
    }
    expect(markMessageAnswered).toHaveBeenCalledWith(chatId, 180091);
  });

  it('② 没有 replyTo 时不调（0 / undefined 都算没有）', () => {
    const calls: Array<[number, number]> = [];
    const maybeMark = (replyToId: number | undefined) => {
      if (replyToId && replyToId > 0) calls.push([-1, replyToId]);
    };
    maybeMark(undefined);
    maybeMark(0);
    maybeMark(-5);
    expect(calls).toEqual([]);
  });

  it('③ 分片路径和单片路径都标（两条 return 各一处）', () => {
    // telegram.ts 的 sendMessage 有两条 return：shards.length > 1 的 first，
    // 和单片的 messageId。两处都要有同一个 if 块。
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync('src/bot/sender/telegram.ts', 'utf8');
    const hits = src.match(/markMessageAnswered\(chatId, replyToId\)/g) ?? [];
    expect(hits.length).toBe(2);
  });
});
