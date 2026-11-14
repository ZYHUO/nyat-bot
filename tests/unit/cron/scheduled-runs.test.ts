import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: vi.fn(), hungRedis: false, config: { DURABLE_CRON_ENABLED: true, PROACTIVE_ACTIVATED_AT_SEC: 0 }, redis: new Map<string,string>() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: state.db }));
vi.mock('../../../src/env.js', () => ({ env: () => state.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ status: 'ready',
  get: async (k: string) => state.redis.get(k) ?? null,
  set: async (k: string, v: string) => { if (state.hungRedis) return new Promise<string>(() => {}); state.redis.set(k, v); return 'OK'; },
  mget: async (...ks: string[]) => ks.map(k => state.redis.get(k) ?? null),
}) }));
vi.mock('../../../src/ai/workload.js', () => ({ runWithAiWorkload: (_lane: string, fn: () => unknown) => fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { claimScheduledRun, finishScheduledRun, getScheduledCompletion, getScheduledRun, renewScheduledRun, startScheduledRun } from '../../../src/cron/scheduled-runs.js';
import { drainHeartbeat, nextTickDueAt, registerTickTask, scanOnceForTest, stopHeartbeat } from '../../../src/cron/heartbeat.js';
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(readFileSync('migrations/0127_scheduled_runs.sql', 'utf8'));
  state.db.mockReturnValue(db); state.redis.clear(); state.hungRedis = false;
});
afterEach(() => { stopHeartbeat(); vi.useRealTimers(); db.close(); });

describe('durable scheduled occurrences', () => {
  it('claims only one owner and advances completion only after success', () => {
    const claim = claimScheduledRun('daily', 1000, true, 1000)!;
    expect(claimScheduledRun('daily', 1000, true, 1000)).toBeNull();
    expect(getScheduledCompletion('daily')).toBe(0);
    expect(startScheduledRun(claim, 1001)).toBe(true);
    expect(finishScheduledRun({ ...claim, owner: 'other' }, 'succeeded', 1002)).toBe(false);
    expect(finishScheduledRun(claim, 'succeeded', 1002)).toBe(true);
    expect(getScheduledCompletion('daily')).toBe(1000);
  });
  it('retries an idempotent failure before the next daily window, using the same occurrence', () => {
    const claim = claimScheduledRun('projection', 1000, true, 1000)!;
    startScheduledRun(claim, 1000); finishScheduledRun(claim, 'failed', 1100);
    expect(getScheduledCompletion('projection')).toBe(0);
    expect(claimScheduledRun('projection', 86401000, true, 2000)).toBeNull();
    const retry = claimScheduledRun('projection', 86401000, true, 31100)!;
    expect(retry).toMatchObject({ scheduledAt: 1000, attempts: 2 });
    startScheduledRun(retry, 31100); finishScheduledRun(retry, 'succeeded', 31200);
    expect(getScheduledCompletion('projection')).toBe(1000);
  });
  it('reclaims never-started work but holds uncertain effects across a restart', () => {
    const old = claimScheduledRun('notice', 1000, false, 1000)!;
    const fresh = claimScheduledRun('notice', 1000, false, 91001)!;
    expect(fresh.owner).not.toBe(old.owner);
    expect(startScheduledRun(old, 91001)).toBe(false);
    startScheduledRun(fresh, 91001);
    expect(claimScheduledRun('notice', 999999, false, 181002)).toBeNull();
    expect(getScheduledRun('notice')?.state).toBe('unknown');
    expect(finishScheduledRun(fresh, 'succeeded', 181002)).toBe(false);
    expect(getScheduledCompletion('notice')).toBe(0);
  });
  it('does not let an expired owner renew or complete someone else’s occurrence', () => {
    const old = claimScheduledRun('cleanup', 1000, true, 1000)!;
    startScheduledRun(old, 1000);
    expect(renewScheduledRun(old, 91001)).toBe(false);
    claimScheduledRun('cleanup', null, true, 91001);
    const fresh = claimScheduledRun('cleanup', null, true, 121001)!;
    startScheduledRun(fresh, 121001);
    expect(finishScheduledRun(old, 'succeeded', 121002)).toBe(false);
    expect(getScheduledRun('cleanup')?.state).toBe('started');
  });
  it('runs through the actual heartbeat and does not treat a rejected daily body as completion', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T15:56:00Z'));
    const run = vi.fn().mockRejectedValueOnce(new Error('synthetic outage')).mockResolvedValue(undefined);
    registerTickTask({ name: 'synthetic-daily', dailyAt: { hour: 23, minute: 55 }, retrySafe: true, run });
    await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getScheduledRun('synthetic-daily')?.state).toBe('failed');
    expect(getScheduledCompletion('synthetic-daily')).toBe(0);
    await vi.advanceTimersByTimeAsync(30001); await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(getScheduledRun('synthetic-daily')?.state).toBe('succeeded');
    expect(getScheduledCompletion('synthetic-daily')).toBe(Date.parse('2026-11-14T15:55:00Z'));
    await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not burn execution retries when the owner crashes before starting', () => {
    for (let i = 0; i < 8; i++) {
      expect(claimScheduledRun('never-started', 1000, true, 1000 + i * 90001)).not.toBeNull();
      expect(getScheduledRun('never-started')?.attempts).toBe(0);
    }
  });
  it('catches up the missed Monday occurrence after a Tuesday restart', () => {
    const sec = (s: string) => Date.parse(s) / 1000;
    const task = { name: 'weekly', weeklyAt: { day: 1, hour: 7, minute: 0 }, run: async () => {} };
    expect(nextTickDueAt(task, sec('2026-11-17T08:00:00Z'), sec('2026-11-08T23:00:00Z'))).toBe(sec('2026-11-15T23:00:00Z'));
  });
  it('does not wait for hung Redis dispatch telemetry before starting durable work', async () => {
    vi.useFakeTimers(); state.hungRedis = true;
    const run = vi.fn().mockResolvedValue(undefined);
    registerTickTask({ name: 'no-redis', everySec: 60, retrySafe: true, run });
    await scanOnceForTest(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    expect(getScheduledRun('no-redis')?.state).toBe('succeeded');
  });
  it('shutdown joins the task body even after its timeout notification', async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    registerTickTask({ name: 'slow-body', everySec: 60, retrySafe: true, run: () => new Promise<void>(resolve => { settle = resolve; }) });
    await scanOnceForTest(); await vi.advanceTimersByTimeAsync(300001);
    let drained = false;
    const joining = drainHeartbeat().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    settle(); await joining;
    expect(drained).toBe(true);
    expect(getScheduledRun('slow-body')?.state).toBe('succeeded');
  });
});
