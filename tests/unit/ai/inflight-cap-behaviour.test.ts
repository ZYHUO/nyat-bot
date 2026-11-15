import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 每个 model 的在飞上限（round 198）——**原子的那一半**。
 *
 * 背景（round 197 已验证）：1275 次 concurrent-limit 报错里 **178 次是
 * 「同一秒内同一个 label 被打多次」**。一条串行链不可能在同一秒内打同一个
 * label 两次，只能是多个并发的 callWithFallback 在同一刻都通过了冷却检查、
 * 然后一起发车。round 83 的冷却是 check-then-launch，天生拦不住。
 *
 * 这里验的是 INCR 那半：并发两次、cap=1，只有一次能拿到坑。
 * 用真的并发（Promise.all）而不是顺序调用——顺序调用第二次会看到第一次
 * 已经放掉的坑，那就验不到原子性。
 */

const {
  callModelMock,
  isCoolingDownMock,
  remainingMock,
  setCooldownCalls,
  inflight,
  envMock,
} = vi.hoisted(() => ({
  callModelMock: vi.fn(),
  isCoolingDownMock: vi.fn(),
  remainingMock: vi.fn(),
  setCooldownCalls: [] as Array<{ model: string; sec?: number }>,
  // 假的 Redis：只实现 incr/decr/expire，语义照真的来
  inflight: new Map<string, number>(),
  envMock: { HEDGE_DELAY_MS: 0, AI_MAX_INFLIGHT_PER_MODEL: 2 },
}));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../src/ai/labels.js', () => ({
  getLabel: vi.fn((name: string) => ({ name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model` })),
  getUsage: vi.fn(() => ({ label: 'primary', backups: [], timeout: 30000 })),
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = isCoolingDownMock;
    setCooldown = async (model: string, sec?: number): Promise<void> => { setCooldownCalls.push({ model, sec }); };
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
    getRemainingSeconds = remainingMock;
  },
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    incr: async (k: string) => { const n = (inflight.get(k) ?? 0) + 1; inflight.set(k, n); return n; },
    decr: async (k: string) => { const n = Math.max(0, (inflight.get(k) ?? 0) - 1); inflight.set(k, n); return n; },
    expire: async () => 1,
  }),
}));
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';

const base = { usage: 'heart', messages: [{ role: 'user' as const, content: 'hi' }], rejectEmpty: true };

beforeEach(() => {
  callModelMock.mockReset();
  isCoolingDownMock.mockReset();
  remainingMock.mockReset();
  setCooldownCalls.length = 0;
  inflight.clear();
  envMock.AI_MAX_INFLIGHT_PER_MODEL = 2;
  isCoolingDownMock.mockResolvedValue(false);
  remainingMock.mockResolvedValue(0);
});

/** 让 provider 挂 40ms——足够让两个并发调用都在"在飞"状态里撞上。 */
function slowOk(): void {
  callModelMock.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { content: 'ok', latencyMs: 1 };
  });
}

describe('每个 model 的在飞上限', () => {
  it('① 并发两次、cap=1 → 只有一次真的发车（原子性）', async () => {
    envMock.AI_MAX_INFLIGHT_PER_MODEL = 1;
    slowOk();
    const results = await Promise.allSettled([callWithFallback(base), callWithFallback(base)]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    // 一个拿到坑发车成功；另一个被挡 → 走"全被挡"路径抛错。
    expect(ok).toBe(1);
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });

  it('② 并发三次、cap=2 → 恰好两次发车', async () => {
    envMock.AI_MAX_INFLIGHT_PER_MODEL = 2;
    slowOk();
    const results = await Promise.allSettled([
      callWithFallback(base), callWithFallback(base), callWithFallback(base),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(2);
    expect(callModelMock).toHaveBeenCalledTimes(2);
  });

  it('③ 串行调用不受影响（坑放掉了就能再来）', async () => {
    slowOk();
    const a = await callWithFallback(base);
    const b = await callWithFallback(base);
    expect(a.content).toBe('ok');
    expect(b.content).toBe('ok');
    expect(callModelMock).toHaveBeenCalledTimes(2);
    // 放干净了：不留坑（否则下一次会被自己的泄漏挡住）
    expect(inflight.get('xxb:ai:inflight:primary-model') ?? 0).toBe(0);
  });

  it('④ 失败路径也放坑（不然一次失败堵死两分钟）', async () => {
    const { AIError } = await import('../../../src/shared/errors.js');
    callModelMock.mockImplementation(async () => { throw new AIError('boom', 'primary', 'primary-model'); });
    await expect(callWithFallback(base)).rejects.toThrow();
    expect(inflight.get('xxb:ai:inflight:primary-model') ?? 0).toBe(0);
  });

  it('⑤ cap=1 时被挡的那次会抛错，而不是静默返回空', async () => {
    envMock.AI_MAX_INFLIGHT_PER_MODEL = 1;
    slowOk();
    const [a, b] = await Promise.allSettled([callWithFallback(base), callWithFallback(base)]);
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(rejected.length).toBe(1);
    const msg = String((rejected[0] as PromiseRejectedResult).reason?.message ?? '');
    expect(msg).toMatch(/in-flight|exhausted|all candidates/i);
  });

  it('⑦ waitIfCooling 的调用方被在飞上限挡下时，要等坑放掉后再试一次（而不是立刻全灭）', async () => {
    // 生产事实：unified-tick 每 5 分钟用 judge 链决策一次，撞上别人占满的坑时 794/797 次直接
    // llm_failed。日志里 skipped 的 coolingForSec 全是 0——不是冷却，是在飞上限。
    // fallback 的"等一等再试"只看 shortestCooldownSec>0，在飞上限挡下时它恒为 0，等待分支进不去。
    envMock.AI_MAX_INFLIGHT_PER_MODEL = 1;
    callModelMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { content: 'ok', latencyMs: 1 };
    });
    const holder = callWithFallback(base);            // 占住唯一的坑 ~60ms
    await new Promise((r) => setTimeout(r, 5));
    const waiter = callWithFallback({ ...base, waitIfCooling: true });
    const [h, w] = await Promise.allSettled([holder, waiter]);
    expect(h.status).toBe('fulfilled');
    expect(w.status).toBe('fulfilled');                // 等坑放掉后重试成功
    expect(callModelMock).toHaveBeenCalledTimes(2);
  });

  it('⑧ 没设 waitIfCooling 的调用方（延迟敏感路径）被挡下仍然立刻失败，不被拖慢', async () => {
    envMock.AI_MAX_INFLIGHT_PER_MODEL = 1;
    callModelMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { content: 'ok', latencyMs: 1 };
    });
    const holder = callWithFallback(base);
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    const quick = callWithFallback({ ...base, maxTimeoutMs: 5000 });   // heart/gate 这类：设了 maxTimeoutMs、没设 waitIfCooling
    await expect(quick).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(40);          // 立刻失败，没有等
    await holder;
  });

  it('⑨ 等完重试也守在飞上限：重试那一刻坑仍被别人占着 → 不能硬发车（否则等于绕过上限）', async () => {
    // holder 占着唯一的坑，且一直占到 waiter 的等待结束之后——此时重试若不占坑直接发车，
    // 同一个 model 上会同时有 2 个在飞（cap=1）。
    vi.useFakeTimers();
    try {
      envMock.AI_MAX_INFLIGHT_PER_MODEL = 1;
      let concurrent = 0;
      let peak = 0;
      callModelMock.mockImplementation(async (_l: unknown, _m: unknown, _o: unknown) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 10_000));   // 远长于 waiter 的 3s 等待
        concurrent--;
        return { content: 'ok', latencyMs: 1 };
      });
      const holder = callWithFallback(base);
      await vi.advanceTimersByTimeAsync(5);
      const waiter = callWithFallback({ ...base, waitIfCooling: true });
      const waiterOutcome = waiter.then(() => 'ok' as const, () => 'rejected' as const);
      await vi.advanceTimersByTimeAsync(3_100);           // 越过 waiter 的 3s 等待 → 它进入重试
      expect(peak).toBe(1);                               // 重试没有硬发车
      await vi.advanceTimersByTimeAsync(10_000);
      await holder;
      expect(await waiterOutcome).toBe('rejected');       // 占不到坑 → 走全灭路径，而不是越界发车
      expect(peak).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⑩ unified-tick 的决策调用声明了 waitIfCooling（不然在飞上限一挡就 llm_failed）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/cron/unified-tick.ts', 'utf8');
    const call = src.slice(src.indexOf('usage: env().UNIFIED_TICK_USAGE'));
    expect(call.slice(0, 1200)).toContain('waitIfCooling: true');
  });

  it('⑥ 上限挡下要记数（AGENTS.md：挡住要可数）', async () => {
    // 结构上确认计数器名稳定（行为断言见 verify-integration）
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/ai/fallback.ts', 'utf8');
    expect(src).toContain("incrCounter('llm_inflight_cap_skipped_total'");
  });
});
