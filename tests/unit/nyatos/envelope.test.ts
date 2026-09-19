import { describe, expect, it, vi, beforeEach } from 'vitest';

// 物理边界的缺口：原 budget 只拦主动发言，而生产流量全在"被叫到"那条路。
// 这个包络先只做一件事：**爆**的时候拦（形状问题），不管总量。

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  incr: vi.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }),
  expire: vi.fn(async () => {}),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const envMock = { TRENCH_ENVELOPE_MODE: 'off', TRENCH_BURST_MAX: 8, TRENCH_BURST_MAX_ACTIVE: 3, TRENCH_BURST_WINDOW_SEC: 300 };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const m = await import('../../../src/nyatos/envelope.js');
beforeEach(() => { store.clear(); redisMock.incr.mockClear(); envMock.TRENCH_ENVELOPE_MODE = 'off'; envMock.TRENCH_BURST_MAX = 8; });

describe('L1 包络', () => {
  it('off 模式零读写', async () => {
    const v = await m.checkEnvelope(-100, true);
    expect(v.ok).toBe(true);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('shadow 模式下允许通过（只观测不拦）', async () => {
    envMock.TRENCH_ENVELOPE_MODE = 'shadow';
    for (let i = 0; i < 20; i++) {
      const v = await m.checkEnvelope(-100, true);
      expect(v.ok).toBe(true);   // shadow 永不拦截
      expect(v.mode).toBe('shadow');
    }
  });

  it('enforce 模式下超总量就拦', async () => {
    envMock.TRENCH_ENVELOPE_MODE = 'enforce';
    const verdicts = [];
    // 用小上限跑（生产默认 150/100 是回测出来的，测试里用 8 快速验证逻辑）
    envMock.TRENCH_BURST_MAX = 8;
    for (let i = 0; i < 10; i++) { await m.spendEnvelope(-100); verdicts.push(await m.checkEnvelope(-100, true)); }
    // 第 8 次 spend 之后 used=8 >= 8，那一次 check 就该被拦
    expect(verdicts.slice(0, 7).every((v) => v.ok)).toBe(true);
    expect(verdicts[7]!.ok).toBe(false);
    expect(verdicts[7]!.why).toBe('blocked_by_burst');
    expect(verdicts[7]!.retryAfterSec).toBeGreaterThan(0);
    expect(verdicts[9]!.ok).toBe(false);   // 之后一直拦
  });

  it('主动的上限更紧：连回 8 个问题是尽职，主动插 8 次话是刷屏', async () => {
    envMock.TRENCH_ENVELOPE_MODE = 'enforce';
    for (let i = 0; i < 5; i++) await m.spendEnvelope(-100);
    // 用了 5 次：主动上限 3 → 已拦；被叫到上限 8 → 还放行
    expect((await m.checkEnvelope(-100, false)).ok).toBe(false);
    expect((await m.checkEnvelope(-100, true)).ok).toBe(true);
    // 用到 8 次：两个都拦
    for (let i = 0; i < 3; i++) await m.spendEnvelope(-100);
    expect((await m.checkEnvelope(-100, true)).ok).toBe(false);
  });

  it('读失败一律放行（护栏不是单点故障）', async () => {
    envMock.TRENCH_ENVELOPE_MODE = 'enforce';
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    expect((await m.checkEnvelope(-100, true)).ok).toBe(true);
  });

  it('拦下的话分两种：回得太密（被叫到）vs 说得太快（主动）', () => {
    const addressed = m.renderEnvelopeBlock({ ok: false, why: 'blocked_by_burst', retryAfterSec: 120, mode: 'enforce' }, true);
    expect(addressed).toContain('回得太密');
    expect(addressed).toContain('并成一条');      // 给的是可执行的出路
    expect(addressed).not.toContain('禁止');
    const active = m.renderEnvelopeBlock({ ok: false, why: 'blocked_by_burst', retryAfterSec: 60, mode: 'enforce' }, false);
    expect(active).toContain('说得太快');
    expect(active).toContain('没人叫你');          // 说清为什么它不适用 direct 豁免
  });
});
