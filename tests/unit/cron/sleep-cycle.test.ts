import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks ────────────────────────────────────────────────────────────
vi.mock('../../../src/env.js', () => {
  const envValues: Record<string, unknown> = {
    SLEEP_SCHEDULE_ENABLED: true,
    SLEEP_ANNOUNCE_ENABLED: true,
    ALLOWLIST_ENABLED: false,     // 跳过 allowlist 分支
    TURN_PROACTIVE_ENABLED: false, // 问候走固定短句池(persona 路径单测略)
    TURN_ACTOR_ENABLED: true,
    TURN_ACTOR_CHAT_IDS: [],
  };
  return { env: () => envValues, _testEnvValues: envValues };
});
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Redis:get/set(NX)/del/zrange/mget
const store = new Map<string, string>();
let activeGroups: number[] = [];
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  zrange: vi.fn(async () => activeGroups.map(String)),
  mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

// 睡眠相位可控
let phase: 'awake' | 'night' | 'nap' = 'awake';
vi.mock('../../../src/tracking/sleep.js', () => ({
  getSleepPhase: vi.fn(async () => phase),
  nightDateStr: vi.fn(() => '2026-06-12'),
}));

// 睡眠队列可控
let queues: { chatId: number; lastTs: number; hasAddressed: boolean }[] = [];
const takeSleepPending = vi.fn(async (chatId: number) => {
  const idx = queues.findIndex((q) => q.chatId === chatId);
  if (idx < 0) return null;
  queues.splice(idx, 1);
  return { entry: { update: {}, chatId, messageId: 42, enqueuedAt: 0 }, rule: 'mention_self', ts: 1 };
});
const clearSleepPending = vi.fn(async (chatId: number) => {
  const idx = queues.findIndex((q) => q.chatId === chatId);
  if (idx >= 0) queues.splice(idx, 1);
});
vi.mock('../../../src/tracking/sleep-queue.js', () => ({
  peekSleepQueues: vi.fn(async () => [...queues]),
  takeSleepPending: (chatId: number) => takeSleepPending(chatId),
  clearSleepPending: (chatId: number) => clearSleepPending(chatId),
}));

const appendPending = vi.fn(async () => ({ count: 1, firstPendingAt: 0 }));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({
  appendPending: (...a: unknown[]) => appendPending(...a),
}));
const scheduleTurn = vi.fn(async () => {});
vi.mock('../../../src/queue/turn-scheduler.js', () => ({
  scheduleTurn: (...a: unknown[]) => scheduleTurn(...a),
}));
let actorChat = true;
vi.mock('../../../src/pipeline/turn/flags.js', () => ({ isTurnActorChat: () => actorChat }));
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({
  generatePersonaProactiveText: vi.fn(async () => null),
}));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 9999 }));

const lastTsByChat = new Map<number, number>();
const addAssistant = vi.fn(async () => {});
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async (chatId: number) => {
    const ts = lastTsByChat.get(chatId);
    return ts ? [{ timestamp: ts, textContent: 'hi' }] : [];
  }),
  addAssistant: (...a: unknown[]) => addAssistant(...a),
}));
const sendMessage = vi.fn(async () => 555);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));
vi.mock('../../../src/tracking/social-needs.js', () => ({ markBotSpoke: vi.fn(async () => {}) }));
vi.mock('../../../src/allowlist/allowlist.js', () => ({ isGroupAllowed: vi.fn(async () => true) }));

const { _testEnvValues: envValues } = (await import('../../../src/env.js')) as unknown as {
  _testEnvValues: Record<string, unknown>;
};
const { runSleepCycle, nightWakeAbsMin } = await import('../../../src/cron/sleep-cycle.js');
const { _resetBedtimeShifts, effectiveSleepMin, daySchedule } = await import(
  '../../../src/tracking/life-state.js'
);

const NOW_SEC = Math.floor(Date.now() / 1000);

beforeEach(() => {
  store.clear();
  lastTsByChat.clear();
  activeGroups = [];
  queues = [];
  phase = 'awake';
  actorChat = true;
  envValues['SLEEP_SCHEDULE_ENABLED'] = true;
  envValues['SLEEP_ANNOUNCE_ENABLED'] = true;
  _resetBedtimeShifts();
  vi.clearAllMocks();
});

describe('runSleepCycle', () => {
  it('flag 关 → 完全 no-op', async () => {
    envValues['SLEEP_SCHEDULE_ENABLED'] = false;
    await runSleepCycle();
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('首次运行 → 静默初始化,不发问候', async () => {
    phase = 'night';
    activeGroups = [-100];
    lastTsByChat.set(-100, NOW_SEC - 60);
    await runSleepCycle();
    expect(store.get('xxb:sleep:laststate')).toBe('asleep');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('awake→night 边沿:向最近活跃群发晚安(去重),nap 不触发', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    phase = 'night';
    activeGroups = [-100, -200];
    lastTsByChat.set(-100, NOW_SEC - 300);       // 活跃 → 发
    lastTsByChat.set(-200, NOW_SEC - 5 * 3600);  // 沉默 → 跳过
    await runSleepCycle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe(-100);
    expect(addAssistant).toHaveBeenCalledTimes(1);

    // nap 算 awake:夜睡转午睡不应触发"起床"边沿
    sendMessage.mockClear();
    phase = 'nap';
    await runSleepCycle();
    // asleep→awake 边沿会发早安 —— 但这里是真实语义:nap 时段在白天,
    // laststate 从 asleep 翻回 awake 属于"早上起床"已发生过;此处只验证
    // nap 不被当成 asleep(否则会再发一轮晚安)
    expect(store.get('xxb:sleep:laststate')).toBe('awake');
  });

  it('night→awake 边沿:欠回复的群优先问候 + 设补回额度', async () => {
    store.set('xxb:sleep:laststate', 'asleep');
    phase = 'awake';
    activeGroups = [-100];
    lastTsByChat.set(-100, NOW_SEC - 600);
    lastTsByChat.set(-300, NOW_SEC - 10 * 3600); // 超窗,但欠着回复 → 仍问候
    queues = [{ chatId: -300, lastTs: 99, hasAddressed: true }];
    await runSleepCycle();
    const greeted = sendMessage.mock.calls.map((c) => c[0]);
    expect(greeted).toContain(-300);
    expect(greeted).toContain(-100);
    // 同一 tick 的排水步骤立即开始补回(唯一欠账群即回放完毕,额度键随之清掉)
    expect(appendPending).toHaveBeenCalledTimes(1);
    expect((appendPending.mock.calls[0]![0] as { chatId: number }).chatId).toBe(-300);
    expect(store.has('xxb:sleep:drain')).toBe(false);
  });

  it('补回排水:每 tick 回放一个 chat,额度递减,清空即停', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    store.set('xxb:sleep:drain', '5');
    queues = [
      { chatId: -1, lastTs: 100, hasAddressed: true },
      { chatId: -2, lastTs: 200, hasAddressed: false },
    ];
    await runSleepCycle(); // 回放 -1(点名优先)
    expect(appendPending).toHaveBeenCalledTimes(1);
    expect((appendPending.mock.calls[0]![0] as { chatId: number; sleepCatchup?: boolean }).chatId).toBe(-1);
    expect((appendPending.mock.calls[0]![0] as { sleepCatchup?: boolean }).sleepCatchup).toBe(true);
    expect(scheduleTurn).toHaveBeenCalledTimes(1);
    expect(store.get('xxb:sleep:drain')).toBe('4');

    await runSleepCycle(); // 回放 -2,队列空 → 额度键删除
    expect(appendPending).toHaveBeenCalledTimes(2);
    expect(store.has('xxb:sleep:drain')).toBe(false);

    await runSleepCycle(); // 没额度键 → 不再回放
    expect(appendPending).toHaveBeenCalledTimes(2);
  });

  it('补回排水:非 turn-actor 群残留 → 先清队列再跳过(不假装回放,不卡死)', async () => {
    actorChat = false; // 灰度名单中途变更,队列里残留了非 actor 群
    store.set('xxb:sleep:laststate', 'awake');
    store.set('xxb:sleep:drain', '5');
    queues = [{ chatId: -1, lastTs: 100, hasAddressed: true }];
    await runSleepCycle();
    expect(clearSleepPending).toHaveBeenCalledWith(-1); // 清掉,不被反复挑中
    expect(takeSleepPending).not.toHaveBeenCalled();    // 不 take-then-drop
    expect(appendPending).not.toHaveBeenCalled();       // 不回放
    expect(store.has('xxb:sleep:drain')).toBe(false);   // 队列空 → 额度键删除,收敛
  });

  it('问候同日去重:边沿抖动不重复发', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    phase = 'night';
    activeGroups = [-100];
    lastTsByChat.set(-100, NOW_SEC - 60);
    await runSleepCycle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // 抖回 awake 再翻回 asleep(同一北京日)
    phase = 'awake';
    await runSleepCycle();
    sendMessage.mockClear();
    phase = 'night';
    await runSleepCycle();
    expect(sendMessage).not.toHaveBeenCalled(); // greeted 键挡住
  });
});

describe('nightWakeAbsMin (seeded 半夜醒)', () => {
  it('确定性 + ~50% 的夜有 + 落在有效睡眠段 40-60%', () => {
    let has = 0;
    const total = 200;
    for (let i = 0; i < total; i++) {
      const date = new Date(Date.parse('2026-01-01') + i * 86400_000).toISOString().slice(0, 10);
      const a = nightWakeAbsMin(date);
      const b = nightWakeAbsMin(date);
      expect(a).toEqual(b); // 同夜确定性
      if (a !== null) {
        has++;
        const start = effectiveSleepMin(date);
        const next = new Date(Date.parse(date) + 86400_000).toISOString().slice(0, 10);
        const end = daySchedule(next).wakeMin + 1440;
        expect(a).toBeGreaterThanOrEqual(start + (end - start) * 0.4 - 1);
        expect(a).toBeLessThanOrEqual(start + (end - start) * 0.6 + 1);
      }
    }
    expect(has / total).toBeGreaterThan(0.35);
    expect(has / total).toBeLessThan(0.65);
  });
});
