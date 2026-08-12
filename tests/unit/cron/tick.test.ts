import { describe, it, expect, beforeEach, vi } from 'vitest';

const callWithFallbackMock = vi.fn();
const getRecentMock = vi.fn();
const enqueueMock = vi.fn();
const sendMessageMock = vi.fn();
const acquireSlotMock = vi.fn();
const personaTextMock = vi.fn();
const redisStore = new Map<string, string>();
const redisLists = new Map<string, string[]>();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    zrange: async () => ['-1001234567890'],
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string, ..._rest: unknown[]) => { redisStore.set(k, v); },
    keys: async (p: string) => [...redisLists.keys()].filter((k) => k.startsWith(p.replace('*', ''))),
    llen: async (k: string) => redisLists.get(k)?.length ?? 0,
  }),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: (...args: unknown[]) => getRecentMock(...args),
  addAssistant: async () => {},
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: async () => false }));
vi.mock('../../../src/cron/active-hours.js', () => ({ isWithinActiveHours: () => true }));
vi.mock('../../../src/cron/proactive-coordinator.js', () => ({
  tryAcquireProactiveSlot: (...args: unknown[]) => acquireSlotMock(...args),
  markProactiveSent: async () => {},
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 999 }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({
  generatePersonaProactiveText: (...args: unknown[]) => personaTextMock(...args),
}));
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: (...args: unknown[]) => enqueueMock(...args),
}));

let envFlags: Record<string, unknown>;
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    UNIFIED_TICK_ENABLED: true,
    UNIFIED_TICK_USAGE: 'judge',
    UNIFIED_TICK_HOUR_START: 0,
    UNIFIED_TICK_HOUR_END: 23,
    MASTER_UID: 6251541967,
    GOAL_TRACKER_ENABLED: false,
    RSS_MONITOR_ENABLED: false,
    SELF_PLAY_COOLDOWN_SEC: 14400,
    BOT_USERNAME: '啾咪囝',
    ...envFlags,
  }),
}));

const { runUnifiedTick, decideTick } = await import('../../../src/cron/unified-tick.js');

const now = Math.floor(Date.now() / 1000);

beforeEach(() => {
  envFlags = {};
  callWithFallbackMock.mockReset();
  getRecentMock.mockReset().mockResolvedValue([
    { role: 'user', uid: 1, fullName: 'AA', username: 'aa', textContent: '有人在吗', timestamp: now - 7200, messageId: 1 },
  ]);
  enqueueMock.mockReset().mockResolvedValue(undefined);
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  acquireSlotMock.mockReset().mockResolvedValue(true);
  personaTextMock.mockReset().mockResolvedValue('大家聊啥呢～');
  redisStore.clear();
  redisLists.clear();
});

describe('decideTick', () => {
  it('parses each action type', async () => {
    const state = {
      hourBeijing: 14, masterSilentSec: 18000, masterLastText: 'x',
      groups: [{ chatId: -1001234567890, silentSec: 5400, lastTexts: 'AA: hi' }],
      dueGoals: [], rssNewCount: 0, selfPlayCooldownLeftSec: 0, lastCareAgoSec: 999999,
    };
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"care_master","text":"主人忙完没~","reason":"沉默5h"}' });
    const v = await decideTick(state);
    expect(v.action.type).toBe('care_master');

    callWithFallbackMock.mockResolvedValue({ content: '{"action":"group_speak","chatId":-1001234567890,"reason":"冷场"}' });
    expect((await decideTick(state)).action.type).toBe('group_speak');

    callWithFallbackMock.mockResolvedValue({ content: '{"action":"self_play","idea":"写个脚本","plan":["a"],"reason":"无聊"}' });
    expect((await decideTick(state)).action.type).toBe('self_play');

    callWithFallbackMock.mockResolvedValue({ content: '{"action":"quiet","reason":"没啥事"}' });
    expect((await decideTick(state)).action.type).toBe('quiet');
  });

  it('garbage output and LLM failure both fail-quiet', async () => {
    const state = {
      hourBeijing: 14, masterSilentSec: null, masterLastText: '',
      groups: [], dueGoals: [], rssNewCount: 0, selfPlayCooldownLeftSec: 0, lastCareAgoSec: 0,
    };
    callWithFallbackMock.mockResolvedValue({ content: '不知道干啥' });
    expect((await decideTick(state)).action.type).toBe('quiet');
    callWithFallbackMock.mockRejectedValue(new Error('down'));
    expect((await decideTick(state)).action.type).toBe('quiet');
  });
});

describe('runUnifiedTick execution mapping', () => {
  it('care_master sends DM and writes last-care key when master silent ≥4h', async () => {
    // buildWorldState reads MASTER_UID recent; default beforeEach is 2h — too fresh for hard veto.
    getRecentMock.mockResolvedValue([
      { role: 'user', uid: 1, fullName: '主人', username: 'm', textContent: '先忙去了', timestamp: now - 5 * 3600, messageId: 1 },
    ]);
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"care_master","text":"主人忙完没~","reason":"x"}' });
    await runUnifiedTick();
    expect(sendMessageMock).toHaveBeenCalledWith(6251541967, '主人忙完没~');
    expect(acquireSlotMock).toHaveBeenCalled();
  });

  it('care_master vetoed when master silent <4h', async () => {
    getRecentMock.mockResolvedValue([
      { role: 'user', uid: 1, fullName: '主人', username: 'm', textContent: '刚说完', timestamp: now - 600, messageId: 1 },
    ]);
    callWithFallbackMock.mockResolvedValue({
      content: '{"action":"care_master","text":"主人～头像还喜欢吗？","reason":"想继续聊"}',
    });
    await runUnifiedTick();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('care_master vetoed when last care <4h ago', async () => {
    getRecentMock.mockResolvedValue([
      { role: 'user', uid: 1, fullName: '主人', username: 'm', textContent: '很久以前', timestamp: now - 10 * 3600, messageId: 1 },
    ]);
    redisStore.set('xxb:proactive:last_care:6251541967', String(now - 600));
    callWithFallbackMock.mockResolvedValue({
      content: '{"action":"care_master","text":"主人～要不要再画一个？","reason":"x"}',
    });
    await runUnifiedTick();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('group_speak validates chatId against world state (rejects hallucinated)', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"group_speak","chatId":-999,"reason":"x"}' });
    await runUnifiedTick();
    expect(personaTextMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('group_speak vetoed when group silent <60min', async () => {
    getRecentMock.mockResolvedValue([
      { role: 'user', uid: 1, fullName: 'AA', username: 'aa', textContent: '刚聊过', timestamp: now - 600, messageId: 1 },
    ]);
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"group_speak","chatId":-1001234567890,"reason":"x"}' });
    await runUnifiedTick();
    expect(personaTextMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('group_speak uses persona pipeline for real cold group', async () => {
    getRecentMock.mockResolvedValue([
      { role: 'user', uid: 1, fullName: 'AA', username: 'aa', textContent: '有人在吗', timestamp: now - 7200, messageId: 1 },
    ]);
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"group_speak","chatId":-1001234567890,"reason":"x"}' });
    await runUnifiedTick();
    expect(personaTextMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).toHaveBeenCalledWith(-1001234567890, '大家聊啥呢～');
  });

  it('care_master vetoed when text peddles self-play products', async () => {
    getRecentMock.mockResolvedValue([
      { role: 'user', uid: 1, fullName: '主人', username: 'm', textContent: '先忙去了', timestamp: now - 5 * 3600, messageId: 1 },
    ]);
    callWithFallbackMock.mockResolvedValue({
      content: '{"action":"care_master","text":"主人～头像还喜欢吗？要不要再画一个？","reason":"x"}',
    });
    await runUnifiedTick();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('self_play dispatches CodeAct and sets cooldown key', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"self_play","idea":"写个贪吃蛇","plan":["写","跑"],"reason":"x"}' });
    await runUnifiedTick();
    expect(enqueueMock).toHaveBeenCalledOnce();
    const task = enqueueMock.mock.calls[0]![0] as { contentDirection: string };
    expect(task.contentDirection).toContain('[selfplay]');
    expect(task.contentDirection).toContain('写个贪吃蛇');
    expect(task.contentDirection).toContain('最多 sendText 一次');
    expect(redisStore.get('xxb:selfplay:last')).toBeTruthy();
  });

  it('self_play vetoed when cooldown active', async () => {
    redisStore.set('xxb:selfplay:last', String(now - 100)); // 100s ago, cooldown 4h
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"self_play","idea":"x idea","plan":[],"reason":"x"}' });
    await runUnifiedTick();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('quiet does nothing', async () => {
    callWithFallbackMock.mockResolvedValue({ content: '{"action":"quiet","reason":"都挺好"}' });
    await runUnifiedTick();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

});
