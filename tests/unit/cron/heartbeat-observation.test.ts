import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickTask, TickTaskOutcome } from '../../../src/cron/heartbeat.js';

const { store, redis, workload } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return { store, redis: {
    status: 'ready',
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
  }, workload: vi.fn((_kind: string, fn: () => unknown) => fn()) };
});
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redis }));
vi.mock('../../../src/env.js', () => ({ env: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/ai/workload.js', () => ({ runWithAiWorkload: workload }));

import { getTickObservations, nextTickDueAt, registerTickTask, scanOnceForTest, startHeartbeat, stopHeartbeat } from '../../../src/cron/heartbeat.js';

const seconds = (iso: string) => Date.parse(iso) / 1000;
const daily = (hour: number): TickTask => ({ name: 'diary', dailyAt: { hour, minute: 0 }, run: async () => {} });

describe('Beijing scheduler epoch calculation', () => {
  it('spreads never-run interval tasks after activation without inventing execution history', () => {
    const epoch = seconds('2026-11-14T16:00:00Z');
    const task: TickTask = { name: 'learner-scan', everySec: 3600, run: async () => {} };
    const due = nextTickDueAt(task, epoch + 1, 0, epoch)!;
    expect(due).toBeGreaterThanOrEqual(epoch + 30);
    expect(due).toBeLessThan(epoch + 930);
    expect(nextTickDueAt(task, epoch + 20, 0, epoch)).toBe(due);
    expect(nextTickDueAt(task, epoch + 3600, epoch + 1, epoch)).toBe(epoch + 3601);
    expect(nextTickDueAt({ ...task, everySec: 10 }, epoch, 0, epoch)).toBe(epoch + 10);
  });

  it('skips pre-activation daily/weekly slots and retains slots after activation', () => {
    const epoch = seconds('2026-11-15T23:00:01Z'); // Monday Beijing 07:00:01.
    const week: TickTask = { name: 'weekly', weeklyAt: { day: 1, hour: 7, minute: 0 }, run: async () => {} };
    expect(nextTickDueAt(daily(7), epoch + 1, 0, epoch)).toBe(seconds('2026-11-16T23:00:00Z'));
    expect(nextTickDueAt(daily(23), epoch + 1, 0, epoch)).toBe(seconds('2026-11-16T15:00:00Z'));
    expect(nextTickDueAt(week, epoch + 1, 0, epoch)).toBe(seconds('2026-11-22T23:00:00Z'));
  });

  it('maps Beijing 07:00 to previous UTC date 23:00, including both sides of the boundary', () => {
    const due = seconds('2026-11-14T23:00:00Z');
    expect(nextTickDueAt(daily(7), due - 1, 0)).toBe(due);
    expect(nextTickDueAt(daily(7), due, 0)).toBe(due);
    expect(nextTickDueAt(daily(7), due + 60, 0)).toBe(due);
    expect(nextTickDueAt(daily(7), due + 60, due)).toBe(due + 86400);
  });
  it('maps Beijing 23:00 to UTC 15:00 and rolls into a new Beijing date at UTC 16:00', () => {
    const due = seconds('2026-11-14T15:00:00Z');
    expect(nextTickDueAt(daily(23), due - 1, 0)).toBe(due);
    expect(nextTickDueAt(daily(23), due + 1, due)).toBe(due + 86400);
    expect(nextTickDueAt(daily(7), seconds('2026-11-14T16:00:00Z'), due)).toBe(seconds('2026-11-14T23:00:00Z'));
  });
  it('uses the Beijing weekday across Sunday UTC / Monday Beijing and rolls completed weekly jobs', () => {
    const task: TickTask = { name: 'weekly', weeklyAt: { day: 1, hour: 7, minute: 0 }, run: async () => {} };
    const due = seconds('2026-11-15T23:00:00Z');
    expect(nextTickDueAt(task, seconds('2026-11-15T15:59:59Z'), 0)).toBe(due);
    expect(nextTickDueAt(task, seconds('2026-11-15T16:00:00Z'), 0)).toBe(due);
    expect(nextTickDueAt(task, due, due)).toBe(due + 7 * 86400);
  });
});

describe('heartbeat runtime observations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T22:59:59Z'));
    stopHeartbeat(); store.clear(); redis.status = 'ready'; vi.clearAllMocks();
  });
  afterEach(() => { stopHeartbeat(); vi.useRealTimers(); });

  it('records explicit skips and duration; void callbacks mean completed, and background context wraps execution', async () => {
    registerTickTask({ name: 'skipper', everySec: 60, run: async () => ({ status: 'skipped', reason: 'no_evidence' }) });
    registerTickTask({ name: 'void', everySec: 60, run: async () => {} });
    startHeartbeat(); await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    const observations = await getTickObservations();
    expect(observations[0]).toMatchObject({ result: 'skipped', reason: 'no_evidence', running: false, durationMs: 0 });
    expect(observations[1]).toMatchObject({ result: 'completed', reason: null });
    expect(observations[0]?.nextRunAt).toBe(Date.now() + 60_000);
    expect(workload).toHaveBeenCalledWith('background', expect.any(Function));
  });

  it('records failures without exporting exception text and projects persisted data after restart', async () => {
    registerTickTask({ name: 'failure', everySec: 60, run: async () => { throw new Error('secret-token-in-error'); } });
    startHeartbeat(); await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    expect((await getTickObservations())[0]).toMatchObject({ result: 'failed', running: false });
    expect(JSON.stringify(await getTickObservations())).not.toContain('secret-token');
    stopHeartbeat();
    store.set('xxb:tick:status:failure', JSON.stringify({ lastStartedAt: 10, result: 'failed', reason: 'secret-token', apiKey: 'secret-token' }));
    registerTickTask({ name: 'failure', everySec: 60, run: async () => {} });
    const persisted = await getTickObservations();
    expect(persisted[0]).toMatchObject({ lastStartedAt: 10, result: 'failed', reason: null, nextRunAt: null });
    expect(JSON.stringify(persisted)).not.toContain('secret-token');
  });

  it('keeps the overlap lock after timeout and does not advance last dispatch while a task is still running', async () => {
    let finish!: (value: void | TickTaskOutcome) => void;
    const run = vi.fn(() => new Promise<void | TickTaskOutcome>((resolve) => { finish = resolve; }));
    registerTickTask({ name: 'slow', everySec: 1, run }); startHeartbeat();
    await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    const dispatched = store.get('xxb:tick:lastrun:slow');
    await vi.advanceTimersByTimeAsync(300_001);
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.get('xxb:tick:lastrun:slow')).toBe(dispatched);
    expect((await getTickObservations())[0]).toMatchObject({ running: true, timedOut: true, result: null });
    finish({ status: 'completed' }); await vi.advanceTimersByTimeAsync(0);
    expect((await getTickObservations())[0]).toMatchObject({ running: false, timedOut: true, result: 'completed', durationMs: 300_001 });
  });

  it('does not enqueue telemetry when Redis is offline and explicitly reports unknown history', async () => {
    registerTickTask(daily(7)); startHeartbeat(); redis.status = 'reconnecting';
    const data = await getTickObservations();
    expect(redis.mget).not.toHaveBeenCalled();
    expect(data[0]).toMatchObject({ historyAvailable: false, nextRunAt: null });
  });

  it('cancels the initial delayed scan on stop', async () => {
    const run = vi.fn(async () => {});
    registerTickTask({ name: 'stopped', everySec: 1, run }); startHeartbeat(); stopHeartbeat();
    registerTickTask({ name: 'new-but-not-started', everySec: 1, run });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });
});
