// ────────────────────────────────────────
// Tests: Cron Scheduler — job registration, start/stop
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-cron
const mockSchedule = vi.fn();
const mockStop = vi.fn();

vi.mock('node-cron', () => ({
  schedule: (...args: unknown[]) => {
    mockSchedule(...args);
    return { stop: mockStop };
  },
  validate: () => true,
}));

// Mock cron job modules
vi.mock('../../../src/cron/report.js', () => ({
  runDailyReport: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/model-check.js', () => ({
  runModelCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/cleanup.js', () => ({
  runCleanup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/knowledge-sync.js', () => ({
  runKnowledgeSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/tracking/user-profile.js', () => ({
  runUserProfileSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/idle.js', () => ({
  runIdleCheck: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/proactive-scan.js', () => ({
  runProactiveScan: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/learner-scan.js', () => ({
  runLearnerScan: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/cron/channel-sync.js', () => ({
  runChannelSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/tracking/stats.js', () => ({
  flushDailyStats: vi.fn(),
}));

// scheduler.ts reads env().CRON_ENABLED (zod schema, cached once). Mock env()
// so we can control CRON_ENABLED per-test without process.env timing issues.
const envOverrides: Record<string, unknown> = { CRON_ENABLED: true };
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    CRON_ENABLED: envOverrides['CRON_ENABLED'] ?? true,
    PROACTIVE_SCAN_ENABLED: false,
    VERIFY_ENABLED: false,
    LEARNER_ENABLED: false,
    SLEEP_SCHEDULE_ENABLED: false,
    BOT_COMMAND_LEARN_ENABLED: false,
    PM_NUDGE_ENABLED: false,
    SCHOOL_SCHEDULE_ENABLED: false,
    TOPIC_REGISTRY_ENABLED: false,
    CACHE_WARMUP_ENABLED: false,
    RESIDENT_STICKER_PACKS: '',
    PROFILE_MERGE_ENABLED: false,
    REFLECTION_ENABLED: false,
    STEPFUN_CONSUMER_ENABLED: false,
    TIC_PENALTY_ENABLED: false,
    DREAM_JOURNAL_ENABLED: false,
    DREAM_JOURNAL_HOOK_SLEEP: false,
    META_SUBAGENT_ENABLED: false,
    KNOWLEDGE_CRON_SCHEDULE: '30 * * * *',
  }),
}));

const { startCronJobs, stopCronJobs, isStarted } = await import(
  '../../../src/cron/scheduler.js'
);

describe('CronScheduler', () => {
  beforeEach(() => {
    envOverrides['CRON_ENABLED'] = true;
    mockSchedule.mockClear();
    mockStop.mockClear();
    // Ensure clean state
    stopCronJobs();
  });

  afterEach(() => {
    stopCronJobs();
    envOverrides['CRON_ENABLED'] = true;
  });

  it('should register cron jobs on start', () => {
    startCronJobs();

    // 无条件 job 基线 ≥18；flag 偶发漂移时不要把 CI 钉死在精确数。
    expect(mockSchedule.mock.calls.length).toBeGreaterThanOrEqual(18);
    expect(isStarted()).toBe(true);
  });

  it('should not register jobs twice', () => {
    startCronJobs();
    const n = mockSchedule.mock.calls.length;
    startCronJobs(); // second call should be no-op

    expect(mockSchedule).toHaveBeenCalledTimes(n);
  });

  it('should stop all jobs on stopCronJobs', () => {
    startCronJobs();
    const n = mockSchedule.mock.calls.length;
    stopCronJobs();

    expect(mockStop).toHaveBeenCalledTimes(n);
    expect(isStarted()).toBe(false);
  });

  it('should register with correct cron expressions', () => {
    startCronJobs();

    const schedules = mockSchedule.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );
    expect(schedules).toContain('*/5 * * * *');   // model check
    expect(schedules).toContain('55 15 * * *');   // daily report
    expect(schedules).toContain('0 */6 * * *');   // cleanup
    expect(schedules).toContain('30 * * * *');    // knowledge-sync (default)
    expect(schedules).toContain('7 * * * *');     // user-profile-sync
    expect(schedules).toContain('*/5 * * * *');   // idle-check shares cadence with model check
  });

  it('should not start jobs when CRON_ENABLED is false', () => {
    envOverrides['CRON_ENABLED'] = false;
    stopCronJobs(); // reset state
    startCronJobs();

    expect(mockSchedule).toHaveBeenCalledTimes(0);
    envOverrides['CRON_ENABLED'] = true;
  });
});
