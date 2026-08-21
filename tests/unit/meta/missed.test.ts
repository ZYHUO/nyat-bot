import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// 内存 Redis list mock
const store = new Map<string, string[]>();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    lpush: async (k: string, v: string) => {
      const arr = store.get(k) ?? [];
      arr.unshift(v);
      store.set(k, arr);
      return arr.length;
    },
    ltrim: async (k: string, start: number, stop: number) => {
      const arr = store.get(k) ?? [];
      store.set(k, arr.slice(start, stop + 1));
      return 'OK';
    },
    lrange: async (k: string, start: number, stop: number) => {
      const arr = store.get(k) ?? [];
      return arr.slice(start, stop + 1);
    },
    expire: async () => 1,
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  }),
}));

describe('missed（「想起再回」话头记录）', () => {
  beforeEach(() => {
    store.clear();
  });

  it('note → peek 往返，最新在前', async () => {
    const { noteMissed, peekMissed } = await import('../../../src/meta/missed.js');
    await noteMissed(-100, { messageId: 1, uid: 42, name: '老白', text: '啾咪囝你看这个' });
    await noteMissed(-100, { messageId: 2, uid: 43, name: '小芹', text: '叫你了怎么不说话' });
    const items = await peekMissed(-100);
    expect(items).toHaveLength(2);
    expect(items[0]!.messageId).toBe(2); // 最新在前
    expect(items[1]!.text).toBe('啾咪囝你看这个');
    expect(items[0]!.ts).toBeGreaterThan(0);
  });

  it('cap 5：第六条挤掉最旧', async () => {
    const { noteMissed, peekMissed } = await import('../../../src/meta/missed.js');
    for (let i = 1; i <= 6; i++) {
      await noteMissed(-100, { messageId: i, uid: 1, name: 'A', text: `msg${i}` });
    }
    const items = await peekMissed(-100);
    expect(items).toHaveLength(5);
    expect(items.map((x) => x.messageId)).toEqual([6, 5, 4, 3, 2]);
  });

  it('clear 后 peek 为空', async () => {
    const { noteMissed, peekMissed, clearMissed } = await import('../../../src/meta/missed.js');
    await noteMissed(-100, { messageId: 1, uid: 1, name: 'A', text: 'x' });
    await clearMissed(-100);
    expect(await peekMissed(-100)).toEqual([]);
  });

  it('不同群互相隔离', async () => {
    const { noteMissed, peekMissed } = await import('../../../src/meta/missed.js');
    await noteMissed(-100, { messageId: 1, uid: 1, name: 'A', text: '群A' });
    await noteMissed(-200, { messageId: 2, uid: 2, name: 'B', text: '群B' });
    expect((await peekMissed(-100))[0]!.text).toBe('群A');
    expect((await peekMissed(-200))[0]!.text).toBe('群B');
  });

  it('join 类型（新人进群）kind 字段保留', async () => {
    const { noteMissed, peekMissed } = await import('../../../src/meta/missed.js');
    await noteMissed(-100, { messageId: 0, uid: 55, name: '新人小明', text: '', kind: 'join' });
    const items = await peekMissed(-100);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('join');
    expect(items[0]!.name).toBe('新人小明');
  });
});
