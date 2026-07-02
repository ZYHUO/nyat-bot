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

// Ensure deterministic env BEFORE scheduler module is imported (env() caches once).
// .env file on the host may have these enabled — explicitly disable here.
process.env['PROACTIVE_SCAN_ENABLED'] = 'false';
process.env['VERIFY_ENABLED'] = 'false';
process.env['LEARNER_ENABLED'] = 'false';
process.env['SLEEP_SCHEDULE_ENABLED'] = 'false';
process.env['BOT_COMMAND_LEARN_ENABLED'] = 'false';
process.env['PM_NUDGE_ENABLED'] = 'false';
process.env['SCHOOL_SCHEDULE_ENABLED'] = 'false';
process.env['TOPIC_REGISTRY_ENABLED'] = 'false';
process.env['CACHE_WARMUP_ENABLED'] = 'false';
process.env['RESIDENT_STICKER_PACKS'] = '';
process.env['PROFILE_MERGE_ENABLED'] = 'false';
process.env['REFLECTION_ENABLED'] = 'false';
process.env['STEPFUN_CONSUMER_ENABLED'] = 'false';

const { startCronJobs, stopCronJobs, isStarted } = await import(
  '../../../src/cron/scheduler.js'
);

describe('CronScheduler', () => {
  beforeEach(() => {
    process.env['VERIFY_ENABLED'] = 'false';
    mockSchedule.mockClear();
    mockStop.mockClear();
    // Ensure clean state
    stopCronJobs();
  });

  afterEach(() => {
    stopCronJobs();
    delete process.env['VERIFY_ENABLED'];
  });

  it('should register cron jobs on start', () => {
    startCronJobs();

    // 顶部已把所有 flag-gated job(proactive/verify/learner/sleep/bot-cmd/pm-nudge/
    // school/resident-sticker)显式关掉,计数确定为无条件 job 数,不随 .env 漂移。
    expect(mockSchedule).toHaveBeenCalledTimes(18);
    expect(isStarted()).toBe(true);
  });

  it('should not register jobs twice', () => {
    startCronJobs();
    startCronJobs(); // second call should be no-op

    expect(mockSchedule).toHaveBeenCalledTimes(18);
  });

  it('should stop all jobs on stopCronJobs', () => {
    startCronJobs();
    stopCronJobs();

    expect(mockStop).toHaveBeenCalledTimes(18);
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
    process.env['CRON_ENABLED'] = 'false';
    stopCronJobs(); // reset state
    startCronJobs();

    expect(mockSchedule).toHaveBeenCalledTimes(0);
    process.env['CRON_ENABLED'] = undefined;
  });
});
