import { describe, expect, it, vi, beforeEach } from 'vitest';

// 卡死自恢复的策略测试。之前这段逻辑内联在 cron 里，测试只能"复刻它的判断"——
// 而复刻的测试验的是复印件。抽成 recoverIfStuck() 之后可以直接调用真代码。

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const fsMock = { appendFileSync: vi.fn(), mkdirSync: vi.fn(), renameSync: vi.fn(), statSync: vi.fn(() => ({ size: 0 })) };
vi.mock('node:fs', () => ({
  appendFileSync: (...a: unknown[]) => fsMock.appendFileSync(...a),
  mkdirSync: (...a: unknown[]) => fsMock.mkdirSync(...a),
  renameSync: (...a: unknown[]) => fsMock.renameSync(...a),
  statSync: (...a: unknown[]) => fsMock.statSync(...a),
}));

const m = await import('../../../src/nyatos/trench.js');
const P = (c: number) => `xxb:trench:p:${c}`;
const SINCE = (c: number) => `xxb:trench:pfull_since:${c}`;

beforeEach(() => { store.clear(); redisMock.get.mockClear(); });

describe('recoverIfStuck', () => {
  it('P 顶格且已超过 stuckHours → 硬复位', async () => {
    const chat = -900;
    store.set(P(chat), '12');
    store.set(SINCE(chat), String(Math.floor(Date.now() / 1000) - 7 * 3600));
    expect(await m.recoverIfStuck(chat, 6)).toBe(true);
    expect((await m.readTrench(chat)).p).toBe(0);
    expect(store.has(SINCE(chat))).toBe(false);   // 计时键清掉
  });

  it('P 顶格但未满 stuckHours → 不复位', async () => {
    const chat = -901;
    store.set(P(chat), '12');
    store.set(SINCE(chat), String(Math.floor(Date.now() / 1000) - 2 * 3600));
    expect(await m.recoverIfStuck(chat, 6)).toBe(false);
    expect(Number(store.get(P(chat)))).toBe(12);
  });

  it('首次发现顶格 → 只起表，不复位', async () => {
    const chat = -902;
    store.set(P(chat), '12');
    expect(await m.recoverIfStuck(chat, 6)).toBe(false);
    expect(store.has(SINCE(chat))).toBe(true);    // 计时键已记
    expect(Number(store.get(P(chat)))).toBe(12);  // P 没动
  });

  it('P 回落 → 清掉计时键（防残留导致误复位）', async () => {
    const chat = -903;
    store.set(P(chat), '3');
    store.set(SINCE(chat), String(Math.floor(Date.now() / 1000) - 8 * 3600));
    expect(await m.recoverIfStuck(chat, 6)).toBe(false);
    expect(store.has(SINCE(chat))).toBe(false);
  });

  it('Redis 读失败 → 不复位（fail-soft，不误杀）', async () => {
    const chat = -904;
    store.set(P(chat), '12');
    store.set(SINCE(chat), String(Math.floor(Date.now() / 1000) - 9 * 3600));
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await m.recoverIfStuck(chat, 6)).toBe(false);
  });

  it('非法 chatId 不动作', async () => {
    expect(await m.recoverIfStuck(0, 6)).toBe(false);
    expect(await m.recoverIfStuck(NaN, 6)).toBe(false);
  });
});
