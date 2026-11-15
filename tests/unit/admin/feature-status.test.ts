import { describe, expect, it } from 'vitest';
import type { Env } from '../../../src/env.js';
import type { TickTaskObservation } from '../../../src/cron/heartbeat.js';
import { buildFeatureStatus } from '../../../src/admin/feature-status.js';

function task(overrides: Partial<TickTaskObservation> = {}): TickTaskObservation {
  return { name: 'dream-journal:7:0', registered: true, running: false, schedule: { dailyAt: { hour: 7, minute: 0 } },
    lastDispatchedAt: null, nextRunAt: null, due: false, historyAvailable: true,
    lastStartedAt: null, lastFinishedAt: null, durationMs: null, result: null, reason: null, timedOut: false, ...overrides };
}
function report(config: Partial<Env>, tasks: TickTaskObservation[] = [], schedulerRunning = true, redisReady = true) {
  return buildFeatureStatus(config as Env, { schedulerRunning, redisReady, tasks, now: 1_800_000_000_000 });
}

describe('feature status manifest', () => {
  it('reports auxiliary image, audio and speech capability without implying direct image replies or successful calls', () => {
    const data = buildFeatureStatus({ AUDIO_TRANSCRIBE_ENABLED: true, TTS_ENABLED: true, REPLY_VISION_ENABLED: false } as Env,
      { schedulerRunning: true, redisReady: true, tasks: [], visionConfigured: true });
    for (const id of ['vision-describe', 'audio', 'tts']) {
      const feature = data.features.find((item) => item.id === id);
      expect(feature?.state).toBe('configured');
      expect(feature?.dependencies[0]?.status).toBe('unknown');
    }
    expect(data.features.find((item) => item.id === 'vision')?.state).toBe('disabled');
  });

  it('distinguishes enabled configuration from an actually registered scheduler', () => {
    const config = { CRON_ENABLED: true, DREAM_JOURNAL_ENABLED: true };
    expect(report(config).features.find((feature) => feature.id === 'diary')?.state).toBe('blocked');
    expect(report(config, [task()], false).features.find((feature) => feature.id === 'diary')?.state).toBe('blocked');
    const diary = report(config, [task()]).features.find((feature) => feature.id === 'diary');
    expect(diary?.state).toBe('scheduled');
    expect(diary?.dependencies).toContainEqual({ id: 'model', label: expect.any(String), status: 'unknown' });
    expect(report({ ...config, CRON_ENABLED: false }, [task()]).features.find((feature) => feature.id === 'diary')?.state).toBe('blocked');
    expect(report(config, [task()], true, false).features.find((feature) => feature.id === 'diary')?.state).toBe('blocked');
  });

  it('reports required feature gates and does not claim event-driven features have run', () => {
    const first = report({ MEMORY_CROSS_CONTEXT_ENABLED: true, TURN_ACTOR_ENABLED: true });
    expect(first.features.find((feature) => feature.id === 'memory-cross-context')?.state).toBe('blocked');
    expect(first.features.find((feature) => feature.id === 'turn')?.state).toBe('configured');
    const second = report({ MEMORY_CROSS_CONTEXT_ENABLED: true, MEMORY_VISIBILITY_ENABLED: true });
    expect(second.features.find((feature) => feature.id === 'memory-cross-context')?.state).toBe('configured');
    expect(second.features.find((feature) => feature.id === 'diary')?.state).toBe('disabled');
  });

  it('shows observed running/failure without interpreting a completed callback as content production', () => {
    const config = { CRON_ENABLED: true, DREAM_JOURNAL_ENABLED: true };
    expect(report(config, [task({ running: true })]).features.find((feature) => feature.id === 'diary')?.state).toBe('running');
    expect(report(config, [task({ result: 'failed' })]).features.find((feature) => feature.id === 'diary')?.state).toBe('degraded');
    const skipped = report(config, [task({ result: 'skipped', reason: 'no_evidence' })]);
    expect(skipped.tasks[0]?.result).toBe('skipped');
    expect(skipped.tasks[0]?.reason).toBe('no_evidence');
    expect(skipped.features.find((feature) => feature.id === 'diary')?.state).toBe('scheduled');
  });

  it('projects only safe fields even when configuration and runtime metadata contain secrets or chat IDs', () => {
    const secret = 'never-return-this-key';
    const chat = -100987654321;
    const config = { MONITOR_TOKEN: secret, BOT_TOKEN: secret, MASTER_UID: chat, TURN_ACTOR_ENABLED: true, TURN_ACTOR_CHAT_IDS: [chat] } as unknown as Env;
    const contaminated = { ...task(), name: `custom:${chat}`, reason: secret, durableState: secret, lastCompletedAt: chat,
      error: secret, chatId: chat, apiKey: secret,
      schedule: { dailyAt: { hour: 7, minute: 0, chatId: chat } } } as TickTaskObservation;
    const data = report(config, [contaminated]);
    const json = JSON.stringify(data);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(String(chat));
    expect(json).not.toContain('BOT_TOKEN');
    expect(json).not.toContain('MONITOR_TOKEN');
    expect(data.tasks[0]?.name).toBe('unlisted-task-1');
    expect(data.tasks[0]?.durableState).toBe('unknown');
    expect(data.tasks[0]?.lastCompletedAt).toBeNull();
    expect(data.features.find((feature) => feature.id === 'turn')?.scope).toBe('restricted');
  });

  it('preserves typed durable state and real completion time without claiming an unknown run succeeded', () => {
    const completed = 1_800_000_001_234;
    const data = report({}, [task({ durableState: 'succeeded', lastCompletedAt: completed }),
      task({ durableState: 'unknown', lastCompletedAt: null, nextRunAt: null })]);
    expect(data.tasks[0]).toMatchObject({ durableState: 'succeeded', lastCompletedAt: completed });
    expect(data.tasks[1]).toMatchObject({ durableState: 'unknown', lastCompletedAt: null, nextRunAt: null });
  });
});
