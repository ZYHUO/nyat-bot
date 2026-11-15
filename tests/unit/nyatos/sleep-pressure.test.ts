import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// L0 × 睡眠接口：睡一觉错过一场对话，醒来头几句该是密的。
// 测试的是**积累**这一半——"醒来后会不会变平缓"由释放与泵浦负责，
// 而那两个已有测试。这里只锁"读到的但没法回的会变成气压"。

// observe() 用 appendFileSync 写 var/trench.jsonl —— 那是**生产**观测文件。
// 不 mock 的话每次跑测试都往里写假 chatId（已发生过：178 行测试残留混进生产日志）。
const fsMock = { appendFileSync: vi.fn(), mkdirSync: vi.fn(), renameSync: vi.fn(), statSync: vi.fn(() => ({ size: 0 })) };
vi.mock('node:fs', () => ({
  appendFileSync: (...a: unknown[]) => fsMock.appendFileSync(...a),
  mkdirSync: (...a: unknown[]) => fsMock.mkdirSync(...a),
  renameSync: (...a: unknown[]) => fsMock.renameSync(...a),
  statSync: (...a: unknown[]) => fsMock.statSync(...a),
}));

const store = new Map<string, string>();
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
    del: async (k: string) => { store.delete(k); return 1; },
  }),
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ TRENCH_SLEEP_PULSE_ENABLED: true }) }));

const m = await import('../../../src/nyatos/trench.js');
beforeEach(() => { store.clear(); });
// observe() 用 appendFileSync 写 var/trench.jsonl，且没有 mock——所以每个测试
// 结束必须清掉，否则测试的假 chatId 会混进生产观测文件（已发生过一次）。

describe('L0 × 睡眠', () => {
  it('每条读到的消息记 0.5 气压，且只对排队的不对划过去的', async () => {
    const chat = -700;
    for (let i = 0; i < 6; i++) await m.pulseForUnheard(chat, 0.5);
    const r = await m.readTrench(chat);
    expect(r.p).toBeCloseTo(3.0, 5);
  });

  it('积累是有界的：睡得再久也撞 P_MAX，不会无限涨', async () => {
    const chat = -701;
    for (let i = 0; i < 100; i++) await m.pulseForUnheard(chat, 0.5);
    expect((await m.readTrench(chat)).p).toBe(12);
  });

  it('醒来后气压偏高 → 速率上限被 g(P) 抬高（这就是"头几句是密的"）', async () => {
    const calm = -702, woken = -703;
    const beforeWake = await m.readTrench(woken);
    for (let i = 0; i < 8; i++) await m.pulseForUnheard(woken, 0.5);   // 睡了一夜
    const afterWake = await m.readTrench(woken);
    expect(afterWake.rate).toBeGreaterThan(beforeWake.rate);
    // 但仍被 R_MAX 夹住：不会因为睡过头就失控
    expect(afterWake.rate).toBeLessThanOrEqual(6);
    expect((await m.readTrench(calm)).rate).toBeLessThan(afterWake.rate);
  });

  it('醒来后的气压会被释放与泵浦压平（不会一直密）', async () => {
    const chat = -704;
    for (let i = 0; i < 8; i++) await m.pulseForUnheard(chat, 0.5);
    const peak = (await m.readTrench(chat)).p;
    await m.releasePressure(chat);            // 说了一句
    const afterSpeak = (await m.readTrench(chat)).p;
    expect(afterSpeak).toBeLessThan(peak * 0.2);   // 一次发言抽掉 85%
    await m.pump(chat);                        // 时间泵再减半
    expect((await m.readTrench(chat)).p).toBeLessThan(afterSpeak);
  });
});
