import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { config, recent, members, groups, goals, call, enqueue, send, persona, store, digestRead, redisList,
  forward, slot, sent, scoreTaste, recordForward, proposals, topics, impulses, dbRows, systemPrompt } = vi.hoisted(() => ({
  config: { PROACTIVE_ACTIVATED_AT_SEC: 0, MASTER_UID: 42, UNIFIED_TICK_HOUR_START: 0, UNIFIED_TICK_HOUR_END: 23,
    UNIFIED_TICK_USAGE: 'judge', SELF_PLAY_COOLDOWN_SEC: 14400, META_SUBAGENT_ENABLED: false,
    MEMORY_SENSITIVE_CHAT_IDS: [] as number[], DIGEST_PERSIST_ENABLED: true, RSS_MONITOR_ENABLED: false,
    UNIFIED_TICK_ABSENT_USERS_ENABLED: false, TRENCH_ENVELOPE_MODE: 'off' },
  recent: vi.fn(), members: vi.fn(), groups: vi.fn(), goals: vi.fn(), call: vi.fn(), enqueue: vi.fn(),
  send: vi.fn(), persona: vi.fn(), store: new Map<string, string>(), digestRead: vi.fn(), redisList: vi.fn(),
  forward: vi.fn(), slot: vi.fn(), sent: vi.fn(), scoreTaste: vi.fn(), recordForward: vi.fn(), proposals: vi.fn(),
  topics: vi.fn(), impulses: vi.fn(), dbRows: vi.fn(), systemPrompt: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ zrevrange: groups, get: async (key: string) => store.get(key) ?? null,
  lrange: redisList, keys: async () => ['xxb:rss:fuel:-100'], llen: async () => 1,
  set: async (key: string, value: string) => { store.set(key, value); return 'OK'; } }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({ prepare: () => ({ all: dbRows }) }) }));
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
vi.mock('../../../src/tracking/topic-registry.js', () => ({ getActiveTopics: topics }));
vi.mock('../../../src/tracking/topic-bandit.js', () => ({ getTopicScores: () => [], pickTopic: (_chatId: number, labels: string[]) => labels[0], recordPull: vi.fn() }));
vi.mock('../../../src/pipeline/rhythm/taste.js', () => ({ scoreTaste, recordForward, wasForwardedRecently: () => false, SHARE_THRESHOLD: 100 }));
vi.mock('../../../src/meta/session-digest.js', () => ({ recentDigests: digestRead }));
vi.mock('../../../src/agent/impulse-history.js', () => ({ getRecentImpulses: impulses }));
vi.mock('../../../src/core/drives/score.js', () => ({ suppress: () => null, deriveDriveValues: () => ({ connection: 0, curiosity: 0, competence: 0, autonomy: 0 }), scoreAction: () => 0 }));
vi.mock('../../../src/core/drives/store.js', () => ({ getDrives: () => [], setDriveValue: vi.fn(), satiate: vi.fn() }));
vi.mock('../../../src/core/agenda/proposals.js', () => ({ proposeActions: proposals, formatProposals: () => '' }));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueCodeActJob: enqueue }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: send, forwardMessage: forward }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({ generatePersonaProactiveText: persona }));
vi.mock('../../../src/cron/proactive-coordinator.js', () => ({ tryAcquireProactiveSlot: slot, markProactiveSent: sent }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 999 }));
vi.mock('../../../src/pipeline/reward/reward-model.js', () => ({ runRewardGate: async () => ({ accept: true }) }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn() }));
vi.mock('../../../src/tracking/outcome.js', () => ({ recordReply: vi.fn() }));
vi.mock('../../../src/nyatos/trench.js', () => ({ releasePressure: vi.fn() }));
vi.mock('../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: (messages: unknown[], current: unknown) => JSON.stringify([...messages, current]) }));
vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({ buildSystemPrompt: systemPrompt }));

import { buildWorldState, decideTick, runUnifiedTick } from '../../../src/cron/unified-tick.js';

function human(timestamp: number) { return { role: 'user', uid: 42, timestamp, textContent: 'test message', fullName: 'Test', messageId: 1 }; }

describe('unified tick activation boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T14:00:00Z'));
    vi.clearAllMocks(); store.clear();
    config.PROACTIVE_ACTIVATED_AT_SEC = Math.floor(Date.now() / 1000) - 24 * 3600;
    config.META_SUBAGENT_ENABLED = false;
    config.MEMORY_SENSITIVE_CHAT_IDS = [];
    config.RSS_MONITOR_ENABLED = false;
    config.UNIFIED_TICK_ABSENT_USERS_ENABLED = false;
    scoreTaste.mockReturnValue({ score: 999 }); proposals.mockReturnValue([]);
    topics.mockReturnValue([]); impulses.mockReturnValue([]); dbRows.mockReturnValue([]);
    slot.mockResolvedValue(true); sent.mockResolvedValue(undefined); persona.mockReset();
    systemPrompt.mockReturnValue('same-chat persona');
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

  it('does not collect message forwarding candidates even when taste would rate them highly', async () => {
    const state = await buildWorldState();
    expect(state.groups).toHaveLength(2);
    expect(state.shareCandidates).toEqual([]);
    expect(scoreTaste).not.toHaveBeenCalled();
    expect(recent.mock.calls.every(([, count]) => count !== 30)).toBe(true);
  });

  it('strips all scoped prose before both global model input and agenda proposals, including legacy candidates', async () => {
    const state = await buildWorldState();
    state.masterLastText = 'CANARY_DM';
    state.groups[0]!.lastTexts = 'CANARY_A'; state.groups[1]!.lastTexts = 'CANARY_B';
    state.shareCandidates = [{ fromChatId: -100, messageId: 1, text: 'CANARY_SHARE', score: 999 }];
    state.absentUsers = [{ chatId: -100, uid: 7, name: 'CANARY_NAME', absentDays: 4 }];
    state.dueGoals = [{ id: 3, topic: 'CANARY_GOAL', lastFinding: 'CANARY_FINDING' }];
    state.dueDebts = [{ id: 4, kind: 'CANARY_KIND', chatId: -100, statement: 'CANARY_DEBT' }];
    state.missed = [{ chatId: -200, name: 'CANARY_MISSED_NAME', text: 'CANARY_MISSED', ageMin: 5 }];
    state.topics = [{ chatId: -100, label: 'CANARY_TOPIC' }];
    state.recentDigests = ['CANARY_DIGEST'];
    state.cognitiveWorkspaces = [{ chatId: -200, text: 'CANARY_WORKSPACE' }];
    impulses.mockReturnValue([{ why: 'CANARY_IMPULSE', verdict: 'speak', atSec: Math.floor(Date.now() / 1000) }]);
    state.rssTopTitles = ['Public release https://example.org/news'];
    state.rssNewCount = 1;
    await decideTick(state);
    const modelInput = JSON.stringify(call.mock.calls[0]![0]);
    expect(modelInput).not.toContain('CANARY_');
    expect(modelInput).toContain('Public release https://example.org/news');
    expect(modelInput).toContain('群 -100'); expect(modelInput).toContain('群 -200');
    expect(JSON.stringify(proposals.mock.calls)).not.toContain('CANARY_');
    expect(proposals.mock.calls[0]![0].world.shareCandidates).toEqual([]);
    expect(impulses).not.toHaveBeenCalled();
    expect(state.groups[0]!.lastTexts).toBe('CANARY_A'); // Local history is preserved.
    expect(state.absentUsers[0]!.name).toBe('CANARY_NAME');
  });

  it('hard-denies a model-selected legacy raw-message share after both chats are activated', async () => {
    call.mockResolvedValue({ content: '{"action":"share","fromChatId":-100,"messageId":1,"toChatId":-200,"reason":"test"}' });
    await runUnifiedTick();
    expect(members).toHaveBeenCalledWith(-100); expect(members).toHaveBeenCalledWith(-200);
    expect(forward).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(persona).not.toHaveBeenCalled(); expect(slot).not.toHaveBeenCalled();
    expect(recordForward).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  });

  it('generates a public-link group message from only the selected chat context after metadata-only scheduling', async () => {
    const now = Math.floor(Date.now() / 1000);
    recent.mockImplementation(async (chatId: number) => [{ ...human(now - 5 * 3600), textContent: chatId === -100 ? 'CANARY_LOCAL_A' : 'CANARY_OTHER_B' }]);
    topics.mockImplementation((chatId: number) => [{ label: chatId === -100 ? 'CANARY_LOCAL_TOPIC' : 'CANARY_OTHER_TOPIC' }]);
    config.RSS_MONITOR_ENABLED = true;
    redisList.mockResolvedValue([JSON.stringify({ title: 'Public release https://example.org/news', source: 'official' })]);
    call.mockImplementation(async (request: { usage: string }) => request.usage === 'judge'
      ? { content: '{"action":"group_speak","chatId":-100,"reason":"公开资讯"}' }
      : { content: '{"replyContent":"新公告：https://example.org/news","targetMessageId":1}' });
    const actual = await vi.importActual<typeof import('../../../src/pipeline/turn/proactive-turn.js')>('../../../src/pipeline/turn/proactive-turn.js');
    persona.mockImplementation(actual.generatePersonaProactiveText);
    await runUnifiedTick();
    const planner = call.mock.calls.find(([request]) => request.usage === 'judge')![0];
    const writer = call.mock.calls.find(([request]) => request.usage === 'reply')![0];
    expect(JSON.stringify(planner)).not.toContain('CANARY_');
    expect(JSON.stringify(writer)).toContain('CANARY_LOCAL_A');
    expect(JSON.stringify(writer)).toContain('CANARY_LOCAL_TOPIC');
    expect(JSON.stringify(writer)).not.toContain('CANARY_OTHER');
    expect(JSON.stringify(writer)).toContain('https://example.org/news');
    expect(systemPrompt).toHaveBeenCalledWith(undefined, -100);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(-100, '新公告：https://example.org/news');
    expect(forward).not.toHaveBeenCalled();
  });

  it('resolves an absent member name only in the selected chat, without sending names to the global model', async () => {
    config.UNIFIED_TICK_ABSENT_USERS_ENABLED = true;
    const lastAt = Math.floor(Date.now() / 1000) - 4 * 86400;
    dbRows.mockReturnValue([{ chatId: -200, uid: 8, name: '小乙', lastAt }, { chatId: -100, uid: 7, name: '小甲', lastAt }]);
    call.mockResolvedValue({ content: '{"action":"remember_user","chatId":-100,"reason":"有缺席记录"}' });
    persona.mockResolvedValue('小甲最近怎么样');
    await runUnifiedTick();
    expect(JSON.stringify(call.mock.calls)).not.toContain('小甲');
    expect(JSON.stringify(call.mock.calls)).not.toContain('小乙');
    expect(persona).toHaveBeenCalledWith(-100, 999, expect.stringContaining('小甲'));
    expect(persona.mock.calls[0]![2]).not.toContain('小乙');
    expect(send).toHaveBeenCalledWith(-100, '小甲最近怎么样');
  });

  it('ignores global care text and generates the DM only from its own conversation', async () => {
    const now = Math.floor(Date.now() / 1000);
    recent.mockImplementation(async (chatId: number) => [{ ...human(now - 5 * 3600), textContent: chatId === 42 ? 'CANARY_OWNER_DM' : 'CANARY_OTHER_GROUP' }]);
    call.mockImplementation(async (request: { usage: string }) => request.usage === 'judge'
      ? { content: '{"action":"care_master","text":"UNTRUSTED_GLOBAL_TEXT","reason":"沉默很久"}' }
      : { content: '{"replyContent":"今天过得怎么样？","targetMessageId":1}' });
    const actual = await vi.importActual<typeof import('../../../src/pipeline/turn/proactive-turn.js')>('../../../src/pipeline/turn/proactive-turn.js');
    persona.mockImplementation(actual.generatePersonaProactiveText);
    await runUnifiedTick();
    const planner = call.mock.calls.find(([request]) => request.usage === 'judge')![0];
    const writer = call.mock.calls.find(([request]) => request.usage === 'reply')![0];
    expect(JSON.stringify(planner)).not.toContain('CANARY_');
    expect(JSON.stringify(writer)).toContain('CANARY_OWNER_DM');
    expect(JSON.stringify(writer)).not.toContain('CANARY_OTHER_GROUP');
    expect(JSON.stringify(writer)).not.toContain('UNTRUSTED_GLOBAL_TEXT');
    expect(systemPrompt).toHaveBeenCalledWith(undefined, 42);
    expect(send).toHaveBeenCalledWith(42, '今天过得怎么样？');
  });
});
