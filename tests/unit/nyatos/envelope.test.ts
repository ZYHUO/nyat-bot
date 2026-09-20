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

const activityMock = vi.fn();
vi.mock('../../../src/tracking/activity.js', () => ({
  getActivitySummary: (...a: unknown[]) => activityMock(...a),
}));

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

// ─── 2026-09-21：突发上限按群活跃度缩放 ────────────────────────────────
//
// 用户原话："日常都有点过高频率，只有在群友都活跃度高的时候高活跃"。
// 在那之前 TRENCH_BURST_MAX/_ACTIVE 是扁平常量——冷清群和热聊群共用一个天花板，
// 于是 Quiet 群里 bot 照样能每小时主动插 20 次。
//
// 缩放用宿主本来就在测的 xxb:activity:{chatId}（zcount 窗口计数），不新增测量。
describe('包络按群活跃度缩放', () => {
  const setActivity = (messages5min: number): void => {
    activityMock.mockResolvedValue({
      messages1min: 0, messages5min, messages15min: messages5min, messages1hour: messages5min,
      activeUsers5min: 1,
      activityLevel: messages5min >= 20 ? '热聊' : messages5min >= 10 ? '活跃' : messages5min >= 3 ? '正常' : messages5min >= 1 ? '冷清' : '沉寂',
    });
  };

  /** 数到被拦为止，返回实际放行条数 = 生效上限。 */
  async function effectiveLimit(chatId: number, addressed: boolean): Promise<number> {
    let ok = 0;
    for (let i = 0; i < 80; i++) {
      const v = await m.checkEnvelope(chatId, addressed);
      if (!v.ok) break;
      ok++;
      await m.spendEnvelope(chatId);
    }
    return ok;
  }

  beforeEach(() => {
    store.clear();
    envMock.TRENCH_ENVELOPE_MODE = 'enforce';
    envMock.TRENCH_BURST_MAX = 8;
    envMock.TRENCH_BURST_MAX_ACTIVE = 4;
    envMock.TRENCH_ENVELOPE_ACTIVITY_SCALED = true;
    activityMock.mockReset();
  });

  it('热聊（5 分钟 ≥20 条）→ 上限 ×1.5', async () => {
    setActivity(25);
    expect(await effectiveLimit(-101, false)).toBe(6);   // 4 × 1.5
  });

  it('活跃（≥10）→ ×1.25', async () => {
    setActivity(12);
    expect(await effectiveLimit(-102, false)).toBe(5);   // 4 × 1.25
  });

  it('正常（≥3）→ ×1.0（与旧行为一致）', async () => {
    setActivity(5);
    expect(await effectiveLimit(-103, false)).toBe(4);
  });

  it('冷清（≥1）→ ×0.5', async () => {
    setActivity(1);
    expect(await effectiveLimit(-104, false)).toBe(2);   // 4 × 0.5
  });

  it('沉寂（0 条）→ ×0.25，但下限 1（不静音）', async () => {
    setActivity(0);
    expect(await effectiveLimit(-105, false)).toBe(1);   // 4 × 0.25 = 1
  });

  it('被叫到的同样缩放（只是基数更大）', async () => {
    setActivity(1);
    expect(await effectiveLimit(-106, true)).toBe(4);    // 8 × 0.5
    setActivity(25);
    expect(await effectiveLimit(-107, true)).toBe(12);   // 8 × 1.5
  });

  it('读不到活跃度 → 按 1.0（退回扁平常量，不因故障改行为）', async () => {
    activityMock.mockRejectedValue(new Error('redis down'));
    expect(await effectiveLimit(-108, false)).toBe(4);
  });

  it('关掉开关 → 完全回到旧行为（扁平上限）', async () => {
    envMock.TRENCH_ENVELOPE_ACTIVITY_SCALED = false;
    setActivity(0);                                       // 再冷清也不缩放
    expect(await effectiveLimit(-109, false)).toBe(4);
  });

  it('缩放后仍不超过 60 的硬上限', async () => {
    envMock.TRENCH_BURST_MAX = 60;
    setActivity(25);                                      // 60 × 1.5 = 90 → 钳到 60
    const limit = await effectiveLimit(-110, true);
    expect(limit).toBeLessThanOrEqual(60);
  });

  it('下限 1：再冷清也不会把包络变成静音（被叫到的仍能出去）', async () => {
    envMock.TRENCH_BURST_MAX_ACTIVE = 1;
    setActivity(0);
    expect(await effectiveLimit(-111, false)).toBe(1);
  });
});
