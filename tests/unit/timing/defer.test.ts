import { describe, it, expect, beforeEach, vi } from 'vitest';

const { appendPendingMock, scheduleTurnMock } = vi.hoisted(() => ({
  appendPendingMock: vi.fn(async () => ({ count: 1, firstPendingAt: 0 })),
  scheduleTurnMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: appendPendingMock }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: scheduleTurnMock }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = { TURN_GATE_DEFER_MAX_REPLAYS: 1 };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

import {
  scheduleGateDeferReeval,
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
  envValues['TURN_GATE_DEFER_MAX_REPLAYS'] = 1;
});

describe('scheduleGateDeferReeval', () => {
  it('append 回 pending(deferReplay+计数)+ 排 gate_defer 回合(forceNew)', async () => {
    const ok = await scheduleGateDeferReeval({
      chatId: -100, entry, deferCount: 0, retryAfterMs: 15_000, reason: 'cooldown_defer',
    });
    expect(ok).toBe(true);
    expect(appendPendingMock).toHaveBeenCalledWith({ ...entry, deferReplay: true, deferCount: 1 });
    expect(scheduleTurnMock).toHaveBeenCalledWith(-100, {
      trigger: 'gate_defer',
      delayMsOverride: 15_000,
      forceNew: true,
    });
  });

  it('延迟 clamp 到 [3s, 10min]', async () => {
    await scheduleGateDeferReeval({ chatId: -100, entry, deferCount: 0, retryAfterMs: 100, reason: 'r' });
    expect((scheduleTurnMock.mock.calls[0]![1] as { delayMsOverride: number }).delayMsOverride).toBe(DEFER_MIN_DELAY_MS);
    await scheduleGateDeferReeval({ chatId: -100, entry, deferCount: 0, retryAfterMs: 99_999_999, reason: 'r' });
    expect((scheduleTurnMock.mock.calls[1]![1] as { delayMsOverride: number }).delayMsOverride).toBe(DEFER_MAX_DELAY_MS);
  });

  it('重放预算耗尽 → false,不排程', async () => {
    const ok = await scheduleGateDeferReeval({
      chatId: -100, entry, deferCount: 1, retryAfterMs: 15_000, reason: 'r',
    });
    expect(ok).toBe(false);
    expect(appendPendingMock).not.toHaveBeenCalled();
    expect(scheduleTurnMock).not.toHaveBeenCalled();
  });
});
