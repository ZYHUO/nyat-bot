import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mocks ────────────────────────────────────────────────────────────
vi.mock('../../../src/env.js', () => {
  const envValues: Record<string, unknown> = {
    SLEEP_SCHEDULE_ENABLED: true,
    SLEEP_ANNOUNCE_ENABLED: true,
    ALLOWLIST_ENABLED: false, // 跳过 allowlist 分支,聚焦边沿逻辑
  };
  return { env: () => envValues, _testEnvValues: envValues };
});

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// in-memory Redis(zrange + get/set,set 支持 NX)
const store = new Map<string, string>();
let activeGroups: number[] = [];
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  zrange: vi.fn(async () => activeGroups.map(String)),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

// isAsleep 可控
let asleep = false;
vi.mock('../../../src/tracking/sleep.js', () => ({
  isAsleep: vi.fn(async () => asleep),
}));

// 上下文:每群最后一条消息的时间戳可控
const lastTsByChat = new Map<number, number>();
const addAssistant = vi.fn(async () => {});
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async (chatId: number) => {
    const ts = lastTsByChat.get(chatId);
    return ts ? [{ timestamp: ts, textContent: 'hi' }] : [];
  }),
  addAssistant: (...args: unknown[]) => addAssistant(...args),
}));

const sendMessage = vi.fn(async () => 555);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

vi.mock('../../../src/tracking/social-needs.js', () => ({
  markBotSpoke: vi.fn(async () => {}),
}));

vi.mock('../../../src/allowlist/allowlist.js', () => ({
  isGroupAllowed: vi.fn(async () => true),
}));

const { _testEnvValues: envValues } = (await import('../../../src/env.js')) as unknown as {
  _testEnvValues: Record<string, unknown>;
};
const { runSleepAnnounce } = await import('../../../src/cron/sleep-announce.js');

const NOW_SEC = Math.floor(Date.now() / 1000);

beforeEach(() => {
  store.clear();
  lastTsByChat.clear();
  activeGroups = [];
  asleep = false;
  envValues['SLEEP_SCHEDULE_ENABLED'] = true;
  envValues['SLEEP_ANNOUNCE_ENABLED'] = true;
  vi.clearAllMocks();
});

describe('runSleepAnnounce (晚安/早安边沿)', () => {
  it('flag 关 → 完全 no-op', async () => {
    envValues['SLEEP_ANNOUNCE_ENABLED'] = false;
    await runSleepAnnounce();
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('首次运行(无 laststate)→ 静默初始化,不发问候', async () => {
    asleep = true;
    activeGroups = [-100];
    lastTsByChat.set(-100, NOW_SEC - 60);
    await runSleepAnnounce();
    expect(store.get('xxb:sleep:laststate')).toBe('asleep');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('状态没翻转 → 不发', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    asleep = false;
    await runSleepAnnounce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('awake→asleep:向最近活跃的群发晚安并入上下文;沉默群跳过', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    asleep = true;
    activeGroups = [-100, -200];
    lastTsByChat.set(-100, NOW_SEC - 5 * 60);        // 5 分钟前有人说话 → 发
    lastTsByChat.set(-200, NOW_SEC - 5 * 3600);      // 5 小时没人说话 → 跳过
    await runSleepAnnounce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe(-100);
    expect(String(sendMessage.mock.calls[0]![1])).toMatch(/晚安|睡|撤/);
    expect(addAssistant).toHaveBeenCalledTimes(1);
    expect(store.get('xxb:sleep:laststate')).toBe('asleep');
  });

  it('asleep→awake:发早安', async () => {
    store.set('xxb:sleep:laststate', 'asleep');
    asleep = false;
    activeGroups = [-100];
    lastTsByChat.set(-100, NOW_SEC - 60);
    await runSleepAnnounce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toMatch(/早|醒|上线/);
  });

  it('同日同种问候去重(NX):第二次边沿不重复发', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    asleep = true;
    activeGroups = [-100];
    lastTsByChat.set(-100, NOW_SEC - 60);
    await runSleepAnnounce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // 状态抖回去再翻回来(同一天)
    store.set('xxb:sleep:laststate', 'awake');
    await runSleepAnnounce();
    expect(sendMessage).toHaveBeenCalledTimes(1); // 没有第二次
  });

  it('活跃群超过 3 个 → 只发最近说话的 3 个', async () => {
    store.set('xxb:sleep:laststate', 'awake');
    asleep = true;
    activeGroups = [-1, -2, -3, -4, -5];
    for (let i = 1; i <= 5; i++) lastTsByChat.set(-i, NOW_SEC - i * 60);
    await runSleepAnnounce();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    const sentTo = sendMessage.mock.calls.map((c) => c[0]);
    expect(sentTo).toEqual([-1, -2, -3]); // 按最近活跃排序
  });
});
