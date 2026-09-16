import { describe, it, expect, beforeEach, vi } from 'vitest';

const { reinjectDeferEntriesMock, scheduleTurnMock, enqueueDeferResumeMock } = vi.hoisted(() => ({
  reinjectDeferEntriesMock: vi.fn(async (): Promise<number> => 1),
  scheduleTurnMock: vi.fn(async () => {}),
  enqueueDeferResumeMock: vi.fn(async () => 'defer-job-id'),
}));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ reinjectDeferEntries: reinjectDeferEntriesMock }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: scheduleTurnMock }));
vi.mock('../../../src/queue/producer.js', () => ({ enqueueDeferResume: enqueueDeferResumeMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = { TURN_GATE_DEFER_MAX_REPLAYS: 1 };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

import {
  scheduleGateDeferReeval,
  handleDeferResume,
  hasDeferBudget,
  DEFER_MIN_DELAY_MS,
  DEFER_MAX_DELAY_MS,
} from '../../../src/pipeline/timing/defer.js';
import type { PendingEntry } from '../../../src/pipeline/turn/types.js';

const entry: PendingEntry = {
  update: {} as PendingEntry['update'],
  chatId: -100,
  messageId: 42,
  enqueuedAt: 1,
};

beforeEach(() => {
  reinjectDeferEntriesMock.mockClear();
  reinjectDeferEntriesMock.mockResolvedValue(1);
  scheduleTurnMock.mockClear();
  enqueueDeferResumeMock.mockClear();
  envValues['TURN_GATE_DEFER_MAX_REPLAYS'] = 1;
});

describe('hasDeferBudget', () => {
  it('deferCount < max → true;达到 max → false', () => {
    expect(hasDeferBudget(undefined)).toBe(true);
    expect(hasDeferBudget(0)).toBe(true);
    expect(hasDeferBudget(1)).toBe(false);
    envValues['TURN_GATE_DEFER_MAX_REPLAYS'] = 2;
    expect(hasDeferBudget(1)).toBe(true);
    expect(hasDeferBudget(2)).toBe(false);
  });
});

describe('scheduleGateDeferReeval — 载荷即暂存(review #1 重做)', () => {
  it('条目存进延迟 job 载荷,不进 pending、不排 turn', async () => {
    const ok = await scheduleGateDeferReeval({
      chatId: -100, entry, deferCount: 0, retryAfterMs: 15_000, reason: 'cooldown_defer',
    });
    expect(ok).toBe(true);
    expect(enqueueDeferResumeMock).toHaveBeenCalledWith(-100, 15_000, [
      { ...entry, deferReplay: true, deferCount: 1 },
    ]);
    // 关键不变量:defer 期间条目只在延迟 job 载荷里(不进 pending、不新建
    // turn job)——避免回合收尾自我重排提前 drain / 覆写 meta.scheduledJobId。
    // 重注入(reinjectDeferEntries)只发生在 job 到点的 handleDeferResume。
    expect(reinjectDeferEntriesMock).not.toHaveBeenCalled();
    expect(scheduleTurnMock).not.toHaveBeenCalled();
  });

  it('延迟 clamp 到 [3s, 10min]', async () => {
    await scheduleGateDeferReeval({ chatId: -100, entry, deferCount: 0, retryAfterMs: 100, reason: 'r' });
    expect(enqueueDeferResumeMock.mock.calls[0]![1]).toBe(DEFER_MIN_DELAY_MS);
    await scheduleGateDeferReeval({ chatId: -100, entry, deferCount: 0, retryAfterMs: 99_999_999, reason: 'r' });
    expect(enqueueDeferResumeMock.mock.calls[1]![1]).toBe(DEFER_MAX_DELAY_MS);
  });

  it('重放预算耗尽 → false,不排程(调用方应放行给 LLM)', async () => {
    const ok = await scheduleGateDeferReeval({
      chatId: -100, entry, deferCount: 1, retryAfterMs: 15_000, reason: 'r',
    });
    expect(ok).toBe(false);
    expect(enqueueDeferResumeMock).not.toHaveBeenCalled();
  });
});

describe('handleDeferResume — 到点重注入(review R3#1 幂等)', () => {
  it('条目经 reinjectDeferEntries(带 dedupToken)重注入 + 排即时回合(不 forceNew)', async () => {
    const stashed = { ...entry, deferReplay: true, deferCount: 1 };
    await handleDeferResume({
      chatId: -100,
      dedupToken: 'defer-job-xyz',
      deferResume: { scheduledAt: 1, entries: [stashed] },
    });
    expect(reinjectDeferEntriesMock).toHaveBeenCalledWith(-100, 'defer-job-xyz', [stashed]);
    expect(scheduleTurnMock).toHaveBeenCalledWith(-100, {
      trigger: 'gate_defer',
      delayMsOverride: 0,
    });
  });

  it('BullMQ 重试:令牌已注入(reinject 返回 -1)→ 不重复注入,仍重排 turn', async () => {
    reinjectDeferEntriesMock.mockResolvedValue(-1);
    const stashed = { ...entry, deferReplay: true, deferCount: 1 };
    await handleDeferResume({
      chatId: -100,
      dedupToken: 'defer-job-xyz',
      deferResume: { scheduledAt: 1, entries: [stashed] },
    });
    // reinject 被调用(它内部原子跳过),返回 -1;turn 仍排(幂等,复用/changeDelay)
    expect(reinjectDeferEntriesMock).toHaveBeenCalledTimes(1);
    expect(scheduleTurnMock).toHaveBeenCalledTimes(1);
  });

  it('空载荷 → 静默返回', async () => {
    await handleDeferResume({ chatId: -100, dedupToken: 't', deferResume: { scheduledAt: 1, entries: [] } });
    await handleDeferResume({ chatId: -100, dedupToken: 't' });
    expect(reinjectDeferEntriesMock).not.toHaveBeenCalled();
    expect(scheduleTurnMock).not.toHaveBeenCalled();
  });
});
