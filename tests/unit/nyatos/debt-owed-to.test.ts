/**
 * owedTo 的契约测试（hermetic，mock 同 debt.test.ts）。
 *
 * 为什么单独写：这个函数的第 1 版有**两个**未定义引用（clamp / hashKey），
 * 而 owedTo 自己的 catch 把它们吞掉、返回 0 —— 于是"债主查询"对**所有** uid
 * 返回 0。dry-run 对真实 Redis 才发现，单测全绿。
 *
 * 这是本会话第七类静默失败的变体：**函数自己抛异常、被自己的 catch 吞掉**。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const hash = new Map<string, Map<string, string>>();
const redisMock = {
  hget: vi.fn(async (k: string, f: string) => hash.get(k)?.get(f) ?? null),
  hset: vi.fn(async (k: string, f: string, v: string) => { if (!hash.has(k)) hash.set(k, new Map()); hash.get(k)!.set(f, v); return 1; }),
  hdel: vi.fn(async (k: string, f: string) => (hash.get(k)?.delete(f) ? 1 : 0)),
  hgetall: vi.fn(async (k: string) => Object.fromEntries(hash.get(k) ?? new Map())),
  expire: vi.fn(async () => {}),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ TRENCH_DEBT_ENABLED: true }) }));

const m = await import('../../../src/nyatos/debt.js');
beforeEach(() => { hash.clear(); });

const CHAT = -1009000111;
const A = 111222333;
const B = 444555666;

describe('debt.owedTo', () => {
  it('债主返回真实欠款额（不为 0）', async () => {
    await m.oweFor(CHAT, A, 0.5);
    await m.oweFor(CHAT, A, 1.0);
    expect(await m.owedTo(CHAT, A)).toBe(1.5);
  });

  it('非债主返回 0', async () => {
    await m.oweFor(CHAT, A, 2.0);
    expect(await m.owedTo(CHAT, B)).toBe(0);
  });

  it('两个债主互不串', async () => {
    await m.oweFor(CHAT, A, 1.0);
    await m.oweFor(CHAT, B, 2.0);
    expect(await m.owedTo(CHAT, A)).toBe(1.0);
    expect(await m.owedTo(CHAT, B)).toBe(2.0);
  });

  it('uid<=0 返回 0', async () => {
    expect(await m.owedTo(CHAT, 0)).toBe(0);
    expect(await m.owedTo(CHAT, -5)).toBe(0);
  });

  it('不存在的群返回 0', async () => {
    expect(await m.owedTo(-1009999888, A)).toBe(0);
  });

  it('销账后读数跟上', async () => {
    await m.oweFor(CHAT, A, 3.0);
    await m.discharge(CHAT, A, 1.0);
    expect(await m.owedTo(CHAT, A)).toBe(2.0);
  });

  it('上限钳到 MAX_OWED=6', async () => {
    await m.oweFor(CHAT, A, 6.0);
    await m.oweFor(CHAT, A, 5.0);
    expect(await m.owedTo(CHAT, A)).toBe(6);
  });
});
