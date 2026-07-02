import { describe, it, expect, beforeEach, vi } from 'vitest';

const { appendPendingMock, scheduleTurnMock, enqueueDeferResumeMock } = vi.hoisted(() => ({
  appendPendingMock: vi.fn(async () => ({ count: 1, firstPendingAt: 0 })),
  scheduleTurnMock: vi.fn(async () => {}),
  enqueueDeferResumeMock: vi.fn(async () => 'defer-job-id'),
}));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: appendPendingMock }));
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
  appendPendingMock.mockClear();
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
    // 关键不变量:defer 期间条目**不在** pending(否则回合收尾自我重排会
    // 提前 drain),也不新建 turn job(否则覆写 meta.scheduledJobId)
    expect(appendPendingMock).not.toHaveBeenCalled();
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

describe('handleDeferResume — 到点重注入', () => {
  it('条目重注入 pending + 排即时回合(不 forceNew:active 回合走 markDirty 收尾重排)', async () => {
    const stashed = { ...entry, deferReplay: true, deferCount: 1 };
    await handleDeferResume({
      chatId: -100,
      deferResume: { scheduledAt: 1, entries: [stashed] },
    });
    expect(appendPendingMock).toHaveBeenCalledWith(stashed);
    expect(scheduleTurnMock).toHaveBeenCalledWith(-100, {
      trigger: 'gate_defer',
      delayMsOverride: 0,
    });
  });

  it('空载荷 → 静默返回', async () => {
    await handleDeferResume({ chatId: -100, deferResume: { scheduledAt: 1, entries: [] } });
    await handleDeferResume({ chatId: -100 });
    expect(appendPendingMock).not.toHaveBeenCalled();
    expect(scheduleTurnMock).not.toHaveBeenCalled();
  });
});
