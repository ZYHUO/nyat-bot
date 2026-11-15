import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, store, recent, members, send, groups, sleepPhase, pending, take, schedule, append } = vi.hoisted(() => ({
  config: { SLEEP_SCHEDULE_ENABLED: true, SLEEP_ANNOUNCE_ENABLED: true, ALLOWLIST_ENABLED: false,
    TURN_PROACTIVE_ENABLED: false, SLEEP_BEDTIME_GUARD_ENABLED: false, PROACTIVE_ACTIVATED_AT_SEC: 0 },
  store: new Map<string, string>(), recent: vi.fn(), members: vi.fn(), send: vi.fn(), groups: vi.fn(),
  sleepPhase: vi.fn(), pending: vi.fn(), take: vi.fn(), schedule: vi.fn(), append: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({
  get: async (key: string) => store.get(key) ?? null,
  set: async (key: string, value: string, ...args: unknown[]) => { if (args.includes('NX') && store.has(key)) return null; store.set(key, value); return 'OK'; },
  del: async (key: string) => store.delete(key), zrange: groups,
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: recent, getGroupMembers: members, addAssistant: vi.fn(async () => {}) }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: send }));
vi.mock('../../../src/tracking/social-needs.js', () => ({ markBotSpoke: vi.fn(async () => {}), getLastSpokeTs: vi.fn(async () => null) }));
vi.mock('../../../src/tracking/sleep.js', () => ({ getSleepPhase: sleepPhase, nightDateStr: () => '2026-11-14', holdBedtime: vi.fn(), isBedtimeHeld: vi.fn(async () => false) }));
vi.mock('../../../src/tracking/life-state.js', () => ({ setBedtimeShift: vi.fn(), effectiveSleepMin: () => 1380, daySchedule: () => ({ wakeMin: 420 }) }));
vi.mock('../../../src/tracking/speech-meter.js', () => ({ getSpeechCounts: vi.fn(async () => ({ todayDate: '2026-11-14', prevDate: '2026-11-13', today: 0, prev: 0 })), bedtimeShiftFromCount: () => 0, bjDateStr: () => '2026-11-14' }));
vi.mock('../../../src/tracking/sleep-queue.js', () => ({ peekSleepQueues: pending, takeSleepPending: take, clearSleepPending: vi.fn(), ADDRESSED_RULES_FOR_PRIORITY: new Set(['mention_self']) }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ appendPending: append }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: schedule }));
vi.mock('../../../src/pipeline/turn/flags.js', () => ({ isTurnActorChat: () => true }));
vi.mock('../../../src/meta/flags.js', () => ({ isMetaSubagentChat: () => false }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({ generatePersonaProactiveText: vi.fn() }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 999 }));
vi.mock('../../../src/allowlist/allowlist.js', () => ({ isGroupAllowed: vi.fn(async () => true) }));

import { runSleepCycle } from '../../../src/cron/sleep-cycle.js';

describe('sleep cycle activation boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T14:00:00Z'));
    vi.clearAllMocks(); store.clear();
    config.PROACTIVE_ACTIVATED_AT_SEC = Math.floor(Date.now() / 1000) - 3600;
    sleepPhase.mockResolvedValue('night'); groups.mockResolvedValue(['-100', '-200', '-300', '-400']);
    pending.mockResolvedValue([]); send.mockResolvedValue(1);
    members.mockImplementation(async (chatId: number) => [{ uid: 42, lastSeen: config.PROACTIVE_ACTIVATED_AT_SEC + (chatId === -400 ? 1 : -1) }]);
    recent.mockImplementation(async (chatId: number) => [{ role: chatId === -400 ? 'user' : 'assistant', uid: chatId === -400 ? 42 : 999,
      timestamp: Math.floor(Date.now() / 1000) - (chatId === -400 ? 300 : Math.abs(chatId / 100)), textContent: 'test' }]);
  });
  afterEach(() => vi.useRealTimers());

  it('filters old destinations before the three-chat cap so new human activity is not starved by bot-only updates', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    await runSleepCycle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(-400, expect.any(String));
    expect(store.has('xxb:sleep:greeted:-100:goodnight:2026-11-14')).toBe(false);
  });

  it('does not greet any chat if all human evidence predates activation, despite recent bot messages', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    groups.mockResolvedValue(['-100', '-200', '-300']);
    await runSleepCycle();
    expect(send).not.toHaveBeenCalled();
  });

  it('drains only newly active destinations and leaves the old destination queue untouched', async () => {
    sleepPhase.mockResolvedValue('awake'); store.set('xxb:sleep:laststate', 'awake'); store.set('xxb:sleep:drain', '1');
    pending.mockResolvedValue([{ chatId: -100, lastTs: 1, hasAddressed: true }, { chatId: -400, lastTs: 2, hasAddressed: true }]);
    take.mockResolvedValue([{ entry: { chatId: -400, messageId: 7, update: {}, enqueuedAt: Date.now() }, rule: 'mention_self', ts: Date.now() / 1000 }]);
    await runSleepCycle();
    expect(take).toHaveBeenCalledTimes(1); expect(take).toHaveBeenCalledWith(-400);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ chatId: -400, sleepCatchup: true }));
    expect(schedule).toHaveBeenCalledWith(-400, expect.objectContaining({ anchorMessageId: 7 }));
  });
});
