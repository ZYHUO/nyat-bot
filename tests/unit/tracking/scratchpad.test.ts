import { describe, it, expect, beforeEach, vi } from 'vitest';

const redisStore = new Map<string, string>();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => { redisStore.set(k, v); },
    del: async (k: string) => { redisStore.delete(k); },
  }),
}));

const { setScratch, clearScratch, getScratch, getScratchSync, scratchPromptBlockSync, warmScratchCache } = await import(
  '../../../src/tracking/scratchpad.js'
);

const CHAT = 6251541967;

beforeEach(() => {
  redisStore.clear();
  // 清进程内缓存
  void clearScratch(CHAT);
});

describe('scratchpad', () => {
  it('set → sync read → prompt block', async () => {
    await setScratch(CHAT, '在等主人的文件');
    expect(getScratchSync(CHAT).length).toBe(1);
    expect(getScratchSync(CHAT)[0]!.text).toBe('在等主人的文件');
    const block = scratchPromptBlockSync(CHAT);
    expect(block).toContain('在等主人的文件');
    expect(block).toContain('[正在惦记着]');
  });

  it('same topic can be replaced via clear+set (model-managed dedup)', async () => {
    await setScratch(CHAT, '在等主人的文件');
    await clearScratch(CHAT, '在等');
    await setScratch(CHAT, '在等主人的贪吃蛇截图');
    const items = getScratchSync(CHAT);
    expect(items.length).toBe(1);
    expect(items[0]!.text).toBe('在等主人的贪吃蛇截图');
  });

  it('FIFO eviction at MAX_ITEMS (4)', async () => {
    for (let i = 0; i < 6; i++) await setScratch(CHAT, `完全不同的事 ${i} 号`);
    const items = getScratchSync(CHAT);
    expect(items.length).toBe(4);
    expect(items[0]!.text).toBe('完全不同的事 2 号');
    expect(items[3]!.text).toBe('完全不同的事 5 号');
  });

  it('clearScratch with prefix removes matching only', async () => {
    await setScratch(CHAT, '在等文件');
    await setScratch(CHAT, '答应帮 XX 查资料');
    await clearScratch(CHAT, '在等');
    const items = getScratchSync(CHAT);
    expect(items.length).toBe(1);
    expect(items[0]!.text).toBe('答应帮 XX 查资料');
  });

  it('clearScratch without prefix wipes all', async () => {
    await setScratch(CHAT, '在等文件');
    await clearScratch(CHAT);
    expect(getScratchSync(CHAT).length).toBe(0);
    expect(scratchPromptBlockSync(CHAT)).toBeNull();
  });

  it('warmScratchCache restores process cache from Redis (restart recovery)', async () => {
    // 模拟另一个进程写入 Redis（本进程缓存没有）
    redisStore.set(`xxb:scratch:${CHAT}`, JSON.stringify([{ text: 'restart 前记的事', at: 123 }]));
    await clearScratch(CHAT); // 清掉缓存但也会删 Redis——重新塞
    redisStore.set(`xxb:scratch:${CHAT}`, JSON.stringify([{ text: 'restart 前记的事', at: 123 }]));
    expect(getScratchSync(CHAT).length).toBe(0);
    await warmScratchCache(CHAT);
    expect(getScratchSync(CHAT).length).toBe(1);
    expect(getScratchSync(CHAT)[0]!.text).toBe('restart 前记的事');
  });

  it('blank text is a no-op', async () => {
    await setScratch(CHAT, '   ');
    expect(getScratchSync(CHAT).length).toBe(0);
  });

  it('getScratch async read stays in sync with Redis', async () => {
    await setScratch(CHAT, 'async 视角');
    const items = await getScratch(CHAT);
    expect(items.length).toBe(1);
    expect(items[0]!.text).toBe('async 视角');
  });
});
