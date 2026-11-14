import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, recent, members, groups, goals, call, enqueue, send, persona, store, digestRead, redisList } = vi.hoisted(() => ({
  config: { PROACTIVE_ACTIVATED_AT_SEC: 0, MASTER_UID: 42, UNIFIED_TICK_HOUR_START: 0, UNIFIED_TICK_HOUR_END: 23,
    UNIFIED_TICK_USAGE: 'judge', SELF_PLAY_COOLDOWN_SEC: 14400, META_SUBAGENT_ENABLED: false,
    MEMORY_SENSITIVE_CHAT_IDS: [] as number[], DIGEST_PERSIST_ENABLED: true },
  recent: vi.fn(), members: vi.fn(), groups: vi.fn(), goals: vi.fn(), call: vi.fn(), enqueue: vi.fn(),
  send: vi.fn(), persona: vi.fn(), store: new Map<string, string>(), digestRead: vi.fn(), redisList: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ zrevrange: groups, get: async (key: string) => store.get(key) ?? null,
  lrange: redisList,
  set: async (key: string, value: string) => { store.set(key, value); return 'OK'; } }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('Unexpected real database access in activation test'); } }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: recent, getGroupMembers: members, addAssistant: vi.fn() }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: call }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: vi.fn(async () => false) }));
vi.mock('../../../src/cron/active-hours.js', () => ({ isWithinActiveHours: () => true }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ getLatestTelegramMessageEventId: () => null, appendCognitiveEvent: vi.fn() }));
vi.mock('../../../src/agent/goals.js', () => ({ listDueGoals: goals }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({ listDueDebtsScoped: () => [] }));
vi.mock('../../../src/shared/weather.js', () => ({ getWeatherHint: vi.fn(async () => null) }));
vi.mock('../../../src/tracking/school-state.js', () => ({ getLifeTransition: () => null }));
vi.mock('../../../src/meta/missed.js', () => ({ peekMissed: vi.fn(async () => []), clearMissed: vi.fn() }));
vi.mock('../../../src/tracking/topic-registry.js', () => ({ getActiveTopics: () => [] }));
vi.mock('../../../src/tracking/topic-bandit.js', () => ({ getTopicScores: () => [] }));
vi.mock('../../../src/pipeline/rhythm/taste.js', () => ({ scoreTaste: () => ({ score: 0 }), wasForwardedRecently: () => false, SHARE_THRESHOLD: 100 }));
vi.mock('../../../src/meta/session-digest.js', () => ({ recentDigests: digestRead }));
vi.mock('../../../src/agent/impulse-history.js', () => ({ getRecentImpulses: () => [] }));
vi.mock('../../../src/core/drives/score.js', () => ({ suppress: () => null, deriveDriveValues: () => ({ connection: 0, curiosity: 0, competence: 0, autonomy: 0 }), scoreAction: () => 0 }));
vi.mock('../../../src/core/drives/store.js', () => ({ getDrives: () => [], setDriveValue: vi.fn(), satiate: vi.fn() }));
vi.mock('../../../src/core/agenda/proposals.js', () => ({ proposeActions: () => [], formatProposals: () => '' }));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueCodeActJob: enqueue }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: send, forwardMessage: vi.fn() }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({ generatePersonaProactiveText: persona }));
vi.mock('../../../src/cron/proactive-coordinator.js', () => ({ tryAcquireProactiveSlot: vi.fn(async () => true), markProactiveSent: vi.fn() }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 999 }));

import { buildWorldState, runUnifiedTick } from '../../../src/cron/unified-tick.js';

function human(timestamp: number) { return { role: 'user', uid: 42, timestamp, textContent: 'test message', fullName: 'Test', messageId: 1 }; }

describe('unified tick activation boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T14:00:00Z'));
    vi.clearAllMocks(); store.clear();
    config.PROACTIVE_ACTIVATED_AT_SEC = Math.floor(Date.now() / 1000) - 24 * 3600;
    config.META_SUBAGENT_ENABLED = false;
    config.MEMORY_SENSITIVE_CHAT_IDS = [];
    digestRead.mockReturnValue([{ text: 'PRIVATE_SQL_DIGEST' }]);
    redisList.mockResolvedValue([JSON.stringify({ text: 'PRIVATE_REDIS_DIGEST' })]);
    groups.mockResolvedValue(['-100', '-200']); goals.mockReturnValue([]);
    recent.mockResolvedValue([human(Math.floor(Date.now() / 1000) - 5 * 3600)]);
    members.mockResolvedValue([{ uid: 42, lastSeen: Math.floor(Date.now() / 1000) - 5 * 3600 }]);
    call.mockResolvedValue({ content: '{"action":"quiet","reason":"test"}' });
    enqueue.mockResolvedValue(undefined); send.mockResolvedValue(1);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps private chat, sensitive group, goal and legacy digest text out of the global planner', async () => {
    config.MEMORY_SENSITIVE_CHAT_IDS = [-200];
    recent.mockImplementation(async (chatId: number) => [{ ...human(Math.floor(Date.now() / 1000) - 60),
      textContent: chatId === 42 ? 'PRIVATE_DM_TEXT' : chatId === -200 ? 'PRIVATE_GROUP_TEXT' : 'SHARED_GROUP_TEXT' }]);
    goals.mockReturnValue([{ id: 1, created_at: config.PROACTIVE_ACTIVATED_AT_SEC + 1, chat_id: 42,
      topic: 'PRIVATE_GOAL_TOPIC', last_finding: 'PRIVATE_GOAL_FINDING' }]);
    const state = await buildWorldState();
    expect(state.groups.map(group => group.chatId)).toEqual([-100]);
    expect(JSON.stringify(state)).toContain('SHARED_GROUP_TEXT');
    expect(JSON.stringify(state)).not.toContain('PRIVATE_');
    expect(state.dueGoals.map(goal => goal.id)).toEqual([1]);
    expect(digestRead).not.toHaveBeenCalled();
    expect(redisList).not.toHaveBeenCalledWith('xxb:meta:digests', expect.anything(), expect.anything());
  });

  it('does not include restored owner or group activity; fresh bot-only messages cannot reactivate it', async () => {
    const epoch = config.PROACTIVE_ACTIVATED_AT_SEC;
    recent.mockImplementation(async (chatId: number) => chatId === -200 ? [human(epoch + 1)] : [human(epoch - 1), { role: 'assistant', uid: 999, timestamp: epoch + 100, textContent: 'bot-only' }]);
    members.mockResolvedValue([{ uid: 42, lastSeen: epoch - 1 }]);
    const state = await buildWorldState();
    expect(state.masterSilentSec).toBeNull();
    expect(state.groups.map((group) => group.chatId)).toEqual([-200]);
  });

  it('allows newly active owner/groups and excludes goals created before or exactly at activation', async () => {
    const epoch = config.PROACTIVE_ACTIVATED_AT_SEC;
    goals.mockReturnValue([999, 1000, 1001].map((offset) => ({ id: offset, created_at: epoch + offset - 1000, topic: 'goal', last_finding: null })));
    const state = await buildWorldState();
    expect(state.masterSilentSec).toBe(5 * 3600);
    expect(state.groups).toHaveLength(2);
    expect(state.dueGoals.map((goal) => goal.id)).toEqual([1001]);
  });

  it.each([
    { action: 'care_master', text: '最近好吗' },
    { action: 'group_speak', chatId: -100 },
    { action: 'share', fromChatId: -100, messageId: 1, toChatId: -200 },
    { action: 'self_play', idea: '学习', plan: ['阅读'] },
  ])('rechecks destination activation before executing an LLM action: $action', async (verdict) => {
    // World-state has new recent messages, but independent delivery-time evidence
    // is absent. A model output alone cannot authorize the destination.
    members.mockResolvedValue([{ uid: 42, lastSeen: config.PROACTIVE_ACTIVATED_AT_SEC }]);
    call.mockResolvedValue({ content: JSON.stringify({ ...verdict, reason: 'test' }) });
    config.META_SUBAGENT_ENABLED = true;
    await runUnifiedTick();
    expect(call).toHaveBeenCalled();
    expect(members).toHaveBeenCalledWith(verdict.action === 'care_master' || verdict.action === 'self_play' ? 42 : -100);
    expect(send).not.toHaveBeenCalled(); expect(persona).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });

  it('checks the share destination separately when the source has new human activity', async () => {
    members.mockImplementation(async (chatId: number) => [{ uid: 42, lastSeen: config.PROACTIVE_ACTIVATED_AT_SEC + (chatId === -100 ? 1 : -1) }]);
    call.mockResolvedValue({ content: '{"action":"share","fromChatId":-100,"messageId":1,"toChatId":-200,"reason":"test"}' });
    await runUnifiedTick();
    expect(members).toHaveBeenCalledWith(-100);
    expect(members).toHaveBeenCalledWith(-200);
    expect(send).not.toHaveBeenCalled(); expect(persona).not.toHaveBeenCalled();
  });

  it('requires the Meta worker for self play, while allowing it when the worker and owner activation are present', async () => {
    call.mockResolvedValue({ content: '{"action":"self_play","idea":"学习","plan":["阅读"],"reason":"test"}' });
    await runUnifiedTick();
    expect(enqueue).not.toHaveBeenCalled();
    config.META_SUBAGENT_ENABLED = true;
    await runUnifiedTick();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ chatId: 42, status: 'queued' }));
  });
});
