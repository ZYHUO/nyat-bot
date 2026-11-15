/**
 * 全候选都被熔断/冷却跳过时的失败形状。
 *
 * 2026-09-21 加。此前这个分支抛的错和"每个 label 都真失败了"**完全一样**
 * （都是 `All labels exhausted`，label/model 都是 'unknown'），但病因和处置相反：
 *
 *   · 真失败   → 该查 provider 的 key/endpoint/额度
 *   · 全跳过   → 该等冷却过去；或者链里全是同一个模型（stepfun/stepfunjudge/
 *                stepfunvision/stepfunthink/stepfunasi 五个 label 共用
 *                step-3.7-flash，一个熔断全死）
 *
 * 不区分的时候，后者看起来像前者，于是一次"等 45 秒就好"的故障会被当成
 * "provider 全挂了"去查。
 *
 * 实测触发路径：连跑几个探针把 step-3.7-flash 的熔断打满，之后 dreaming 的 4 个
 * 候选全部在冷却中 → 25ms 内失败，零条 per-label 日志。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callModelMock, isCoolingDownMock, remainingMock, loggerMock } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
  isCoolingDownMock: vi.fn(async (): Promise<boolean> => false),
  remainingMock: vi.fn(async (): Promise<number> => 0),
  loggerMock: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['hedge', 'last'], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({ name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model` })),
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = isCoolingDownMock;
    setCooldown = async (): Promise<void> => {};
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
    getRemainingSeconds = remainingMock;
  },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 0 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: loggerMock }));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';

const opts = { usage: 'heart', messages: [{ role: 'user' as const, content: 'hi' }], rejectEmpty: true };

beforeEach(() => {
  callModelMock.mockReset();
  isCoolingDownMock.mockReset();
  isCoolingDownMock.mockResolvedValue(false);
  remainingMock.mockReset();
  remainingMock.mockResolvedValue(0);
  loggerMock.warn.mockClear();
});

describe('全候选被冷却跳过', () => {
  it('① 一次都没尝试 → 抛错，且错误信息说明是"全在冷却"而不是"全失败"', async () => {
    isCoolingDownMock.mockResolvedValue(true);
    remainingMock.mockResolvedValue(0);   // 0 = 不知道还要多久 → 不等，直接抛
    await expect(callWithFallback(opts)).rejects.toThrow(/all candidates cooling down/i);
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it('② 打一条 warn，点名每个被跳过的 label + 冷却剩余秒数', async () => {
    isCoolingDownMock.mockResolvedValue(true);
    remainingMock.mockResolvedValue(0);
    await expect(callWithFallback(opts)).rejects.toThrow();
    const call = loggerMock.warn.mock.calls.find((c) => String(c[1]).includes('nothing was attempted'));
    expect(call).toBeDefined();
    const payload = call![0] as { candidates: string[]; skipped: Array<{ label: string; coolingForSec: number }> };
    expect(payload.candidates).toEqual(['primary', 'hedge', 'last']);
    expect(payload.skipped).toHaveLength(3);
    expect(payload.skipped[0]).toMatchObject({ label: 'primary', coolingForSec: 0 });
  });

  // 2026-09-21：全被冷却时等最短的那个醒来再试一次（不等就立刻失败太亏——
  // 实测剩余冷却多是 2-46 秒，等十几秒就有一条能用）。
  describe('等最短冷却醒来再试一次', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('⑥ 两个候选都冷却、等完有一个就好了 → 返回结果，不抛', async () => {
      // 注意：第一版写成 `mockResolvedValueOnce(true).mockResolvedValue(false)`，
      // 于是第二个 label 本来就没冷却 → 正常循环直接用它 → **等待重试那段根本没跑，
      // 测试却绿了**。必须让第一轮两个 label 全冷却，等待之后才恢复。
      // 链里有 **3** 个 label（getUsage mock: primary + [hedge, last]），
      // 所以前三轮调用都要冷却，等待之后才恢复。第一版写 n<=2，于是第三个
      // label 本来就没冷却、主循环直接用它成功——等待那段一行没跑，测试却绿。
      let n = 0;
      isCoolingDownMock.mockImplementation(async () => { n++; return n <= 3; });
      remainingMock.mockResolvedValue(5);
      callModelMock.mockResolvedValue({ content: '{"ok":1}', label: 'primary', model: 'primary-model', latencyMs: 1, tokenUsage: { prompt: 1, completion: 1, total: 2 } });
      const p = callWithFallback(opts);
      await vi.advanceTimersByTimeAsync(6000);
      const r = await p;
      expect(r.content).toBe('{"ok":1}');
      expect(callModelMock).toHaveBeenCalledTimes(1);
      // **这条断言才是真正的守卫**：证明"等待重试"那段真的跑了。
      // 没有它，第二个 label 只要没在冷却，正常循环就直接成功——测试绿了，
      // 而等待那段一行都没执行（我就这么写过一版假绿）。
      expect(loggerMock.debug.mock.calls.some((c) => String(c[1]).includes('all candidates cooling'))).toBe(true);
    });

    it('⑥b 等完还都在冷却 → 仍然抛（不假装成功）', async () => {
      isCoolingDownMock.mockResolvedValue(true);
      remainingMock.mockResolvedValue(5);
      const p = callWithFallback(opts).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(20000);
      const e = await p;
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/cooling down/i);
    });

    it('⑥c 等多久有上界（15s），不会把调用方熬死', async () => {
      isCoolingDownMock.mockResolvedValue(true);
      remainingMock.mockResolvedValue(600);   // 剩余 10 分钟
      const p = callWithFallback(opts).catch(() => 'threw');
      await vi.advanceTimersByTimeAsync(16000);   // 上界 15s，所以 16s 时一定已抛
      expect(await p).toBe('threw');              // 没傻等 600s
    });

    it('⑥d 延迟敏感路径（带 maxTimeoutMs）不等——直接抛', async () => {
      isCoolingDownMock.mockResolvedValue(true);
      remainingMock.mockResolvedValue(5);
      await expect(callWithFallback({ ...opts, maxTimeoutMs: 8000 })).rejects.toThrow(/cooling down/i);
      expect(callModelMock).not.toHaveBeenCalled();
    });

    it('⑥f 后台批任务用 waitIfCooling 覆盖"带 maxTimeoutMs 就不等"', async () => {
      // 2026-09-21：deep-reflection 一次 tick 15 群全灭，err 全是
      // `All labels exhausted (all candidates cooling down)`，而最短冷却只有十几秒。
      // 它设了 maxTimeoutMs（每跳封顶），于是拿不到等待重试。这个开关就是给它开的。
      let n = 0;
      isCoolingDownMock.mockImplementation(async () => { n++; return n <= 3; });
      remainingMock.mockResolvedValue(5);
      callModelMock.mockResolvedValue({ content: '{"ok":1}', label: 'primary', model: 'primary-model', latencyMs: 1, tokenUsage: { prompt: 1, completion: 1, total: 2 } });
      const p = callWithFallback({ ...opts, maxTimeoutMs: 20000, waitIfCooling: true });
      await vi.advanceTimersByTimeAsync(6000);
      const r = await p;
      expect(r.content).toBe('{"ok":1}');
      expect(loggerMock.debug.mock.calls.some((c) => String(c[1]).includes('all candidates cooling'))).toBe(true);
    });

    it('⑥g waitIfCooling=false 时 maxTimeoutMs 仍然让它不等（显式关掉）', async () => {
      isCoolingDownMock.mockResolvedValue(true);
      remainingMock.mockResolvedValue(5);
      await expect(
        callWithFallback({ ...opts, maxTimeoutMs: 20000, waitIfCooling: false }),
      ).rejects.toThrow(/cooling down/i);
      expect(callModelMock).not.toHaveBeenCalled();
    });

    it('⑥e 带外部 signal 的路径不等（调用方能取消，不该被 sleep 卡住）', async () => {
      const ac = new AbortController();
      isCoolingDownMock.mockResolvedValue(true);
      remainingMock.mockResolvedValue(5);
      await expect(callWithFallback({ ...opts, signal: ac.signal })).rejects.toThrow(/cooling down/i);
      expect(callModelMock).not.toHaveBeenCalled();
    });
  });

  it('③ 真失败时不走这个分支（错误信息保持原样，不带 cooling down）', async () => {
    callModelMock.mockRejectedValue(new Error('boom'));
    await expect(callWithFallback(opts)).rejects.toThrow('boom');
    const call = loggerMock.warn.mock.calls.find((c) => String(c[1]).includes('nothing was attempted'));
    expect(call).toBeUndefined();
  });

  it('④ 部分候选可用 → 正常走，不碰这个分支', async () => {
    isCoolingDownMock.mockImplementation(async (m: string) => m === 'primary-model');
    callModelMock.mockResolvedValue({ content: '{"ok":1}', label: 'hedge', model: 'hedge-model', latencyMs: 1, tokenUsage: { prompt: 1, completion: 1, total: 2 } });
    const r = await callWithFallback(opts);
    expect(r.content).toBe('{"ok":1}');
    const call = loggerMock.warn.mock.calls.find((c) => String(c[1]).includes('nothing was attempted'));
    expect(call).toBeUndefined();
  });

  it('⑤ 全跳过时也记 llm error 指标（监控看得见）', async () => {
    isCoolingDownMock.mockResolvedValue(true);
    remainingMock.mockResolvedValue(0);   // 不等，直接走完
    await expect(callWithFallback(opts)).rejects.toThrow();
    // emitLlmError 在每次 attempt 失败时调用；全跳过时一次 attempt 都没有，
    // 所以这条指标为 0 —— 正是这个失败形状此前的盲点，warn 补上。
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
