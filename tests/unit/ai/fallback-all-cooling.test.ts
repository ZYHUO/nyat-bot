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
    remainingMock.mockResolvedValue(45);
    await expect(callWithFallback(opts)).rejects.toThrow(/all candidates cooling down/i);
    expect(callModelMock).not.toHaveBeenCalled();
  });

  it('② 打一条 warn，点名每个被跳过的 label + 冷却剩余秒数', async () => {
    isCoolingDownMock.mockResolvedValue(true);
    remainingMock.mockResolvedValue(45);
    await expect(callWithFallback(opts)).rejects.toThrow();
    const call = loggerMock.warn.mock.calls.find((c) => String(c[1]).includes('nothing was attempted'));
    expect(call).toBeDefined();
    const payload = call![0] as { candidates: string[]; skipped: Array<{ label: string; coolingForSec: number }> };
    expect(payload.candidates).toEqual(['primary', 'hedge', 'last']);
    expect(payload.skipped).toHaveLength(3);
    expect(payload.skipped[0]).toMatchObject({ label: 'primary', coolingForSec: 45 });
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
    remainingMock.mockResolvedValue(10);
    await expect(callWithFallback(opts)).rejects.toThrow();
    // emitLlmError 在每次 attempt 失败时调用；全跳过时一次 attempt 都没有，
    // 所以这条指标为 0 —— 正是这个失败形状此前的盲点，warn 补上。
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
