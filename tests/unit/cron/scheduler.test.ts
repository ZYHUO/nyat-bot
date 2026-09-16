// ────────────────────────────────────────
// Tests: Scheduler(tick 心跳版) — 任务注册、start/stop
//
// 调度层已从 node-cron 迁到 heartbeat.ts 的任务注册表:
//   everySec(n) / dailyAt(h,m) / weeklyAt(d,h,m)
// 测试断言注册表内容(getTickRegistry),不再断言 cron 表达式。
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    VERIFY_ENABLED: false,
    LEARNER_ENABLED: false,
    SLEEP_SCHEDULE_ENABLED: false,
    BOT_COMMAND_LEARN_ENABLED: false,
    SCHOOL_SCHEDULE_ENABLED: false,
    TOPIC_REGISTRY_ENABLED: false,
    CACHE_WARMUP_ENABLED: false,
    RESIDENT_STICKER_PACKS: '',
    PROFILE_MERGE_ENABLED: false,
    REFLECTION_ENABLED: false,
    STEPFUN_CONSUMER_ENABLED: false,
    TIC_PENALTY_ENABLED: false,
    DREAM_JOURNAL_ENABLED: false,
    DREAMING_ENABLED: false,
    DREAM_CONSOLIDATE_ENABLED: false,
    SILENCE_ALERT_ENABLED: false,
    KNOWLEDGE_CRON_SCHEDULE: '30 * * * *',
    UNIFIED_TICK_INTERVAL_MIN: 5,
    SKILL_DISTILL_ENABLED: false,
    SKILL_CONSOLIDATE_ENABLED: false,
    HOBBY_DISTILL_ENABLED: false,
    RSS_MONITOR_ENABLED: false,
  }),
}));

// Mock heartbeat 的 Redis 依赖(scan 会读 lastRun;测试里不真跑任务)
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async () => null,
    set: async () => 'OK',
  }),
}));

const { startCronJobs, stopCronJobs, isStarted } = await import(
  '../../../src/cron/scheduler.js'
);
const { getTickRegistry } = await import(
  '../../../src/cron/heartbeat.js'
);

describe('CronScheduler(tick 心跳版)', () => {
  beforeEach(() => {
    envOverrides['CRON_ENABLED'] = true;
    stopCronJobs();
  });

  afterEach(() => {
    stopCronJobs();
    envOverrides['CRON_ENABLED'] = true;
  });

  it('should register tick tasks on start', () => {
    startCronJobs();

    // 无条件任务基线 ≥15(flag 偶发漂移时不要把 CI 钉死在精确数)
    expect(getTickRegistry().length).toBeGreaterThanOrEqual(15);
    expect(isStarted()).toBe(true);
  });

  it('should not register jobs twice', () => {
    startCronJobs();
    const n = getTickRegistry().length;
    startCronJobs(); // second call should be no-op

    expect(getTickRegistry().length).toBe(n);
  });

  it('should clear registry on stopCronJobs', () => {
    startCronJobs();
    expect(getTickRegistry().length).toBeGreaterThan(0);
    stopCronJobs();

    expect(getTickRegistry().length).toBe(0);
    expect(isStarted()).toBe(false);
  });

  it('should register core tasks with correct intervals', () => {
    startCronJobs();

    const byName = new Map(getTickRegistry().map((t) => [t.name, t]));
    // model check — every 5 minutes
    expect(byName.get('model-check')?.everySec).toBe(5 * 60);
    // daily report — 北京 23:55
    expect(byName.get('daily-report')?.dailyAt).toEqual({ hour: 23, minute: 55 });
    // cleanup — every 6 hours
    expect(byName.get('cleanup')?.everySec).toBe(6 * 3600);
    // knowledge-sync — '30 * * * *' 解析为每小时
    expect(byName.get('knowledge-sync')?.everySec).toBe(60 * 60);
    // user-profile-sync — hourly
    expect(byName.get('user-profile-sync')?.everySec).toBe(3600);
    // unified-tick — 5 分钟间隔,只是注册表里的普通任务
    expect(byName.get('unified-tick')?.everySec).toBe(5 * 60);
  });

  it('should not start jobs when CRON_ENABLED is false', () => {
    envOverrides['CRON_ENABLED'] = false;
    stopCronJobs(); // reset state
    startCronJobs();

    expect(getTickRegistry().length).toBe(0);
    envOverrides['CRON_ENABLED'] = true;
  });
});
