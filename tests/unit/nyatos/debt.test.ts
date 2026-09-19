import { describe, expect, it, vi, beforeEach } from 'vitest';

// 评审 3 的反对意见：无方向的睡眠积压醒来后只被半衰期压平（时钟驱动=痉挛签名）。
// 定向债把衰减改成由"还债"驱动（闭环驱动=活人）。这里锁这几个不变量。

const hash = new Map<string, Map<string, string>>();
const redisMock = {
  hget: vi.fn(async (k: string, f: string) => hash.get(k)?.get(f) ?? null),
  hset: vi.fn(async (k: string, f: string, v: string) => { if (!hash.has(k)) hash.set(k, new Map()); hash.get(k)!.set(f, v); return 1; }),
  hdel: vi.fn(async (k: string, f: string) => (hash.get(k)?.delete(f) ? 1 : 0)),
  hgetall: vi.fn(async (k: string) => Object.fromEntries(hash.get(k) ?? new Map())),
  expire: vi.fn(async () => {}),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
const envMock = { TRENCH_DEBT_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const m = await import('../../../src/nyatos/debt.js');
beforeEach(() => { hash.clear(); redisMock.hset.mockClear(); });

describe('定向债', () => {
  it('债记在发送者头上，不是记在群上', async () => {
    await m.oweFor(-100, 111, 0.5);
    await m.oweFor(-100, 222, 1);
    const all = await m.readDebt(-100);
    expect(all).toHaveLength(2);
    expect(all.find((d) => d.uid === 222)!.owed).toBe(1);
    expect(all.find((d) => d.uid === 111)!.owed).toBe(0.5);
  });

  it('flag 关时零动作（与仓库约定一致，默认 OFF）', async () => {
    envMock.TRENCH_DEBT_ENABLED = false;
    await m.oweFor(-100, 111, 1);
    expect(await m.readDebt(-100)).toHaveLength(0);
    envMock.TRENCH_DEBT_ENABLED = true;
  });

  it('没有发送者就没有方向（不记）', async () => {
    await m.oweFor(-100, 0, 1);
    await m.oweFor(-100, -5, 1);
    expect(await m.readDebt(-100)).toHaveLength(0);
  });

  it('单笔债有硬上界：一夜攒不成巨债', async () => {
    for (let i = 0; i < 40; i++) await m.oweFor(-100, 111, 1);
    const d = await m.readDebt(-100);
    expect(d[0]!.owed).toBe(6);
  });

  it('真的回给了他 → 销账（这是"闭环驱动衰减"的兑现点）', async () => {
    await m.oweFor(-100, 111, 2);
    await m.discharge(-100, 111, 1);
    expect((await m.readDebt(-100))[0]!.owed).toBe(1);
    await m.discharge(-100, 111, 5);      // 还超了
    expect(await m.readDebt(-100)).toHaveLength(0);   // 整笔清掉，不留 0 值垃圾
  });

  it('还给 A 不动 B 的债', async () => {
    await m.oweFor(-100, 111, 1);
    await m.oweFor(-100, 222, 2);
    await m.discharge(-100, 111, 1);
    const rest = await m.readDebt(-100);
    expect(rest).toHaveLength(1);
    expect(rest[0]!.uid).toBe(222);
  });

  it('总债是所有债主之和（readDebt 已够，不需要第二个求和出口）', async () => {
    await m.oweFor(-100, 111, 1);
    await m.oweFor(-100, 222, 2);
    const all = await m.readDebt(-100, 50);
    expect(all.reduce((s, x) => s + x.owed, 0)).toBe(3);
  });

  it('渲染是"欠话"不是工单队列', async () => {
    await m.oweFor(-100, 111, 2);
    const line = await m.renderDebt(-100);
    expect(line).toContain('[欠话]');
    expect(line).toContain('欠 2 句');
    expect(line).toContain('你定');          // 不替模型决定还不还
    expect(line).not.toContain('待回复');
    expect(line).not.toContain('队列');
    // 拿不到昵称就说"那个人"，不编名字
    expect(line).toContain('那个人');
  });

  it('有昵称映射时用真名', async () => {
    await m.oweFor(-100, 111, 1);
    const line = await m.renderDebt(-100, (uid) => (uid === 111 ? '小美' : null));
    expect(line).toContain('小美');
  });

  it('没债就不渲染', async () => {
    expect(await m.renderDebt(-100)).toBe('');
  });
});
