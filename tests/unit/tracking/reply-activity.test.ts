import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Redis mock: 支持 set/scanStream/mget/ping ──
const store = new Map<string, string>();
const redisMock = {
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, String(v));
    return 'OK';
  }),
  mget: vi.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  ping: vi.fn(async () => 'PONG'),
  scanStream: vi.fn(() => {
    // 简易 scanStream:一次性吐出所有 lastHumanDirect key(扫描只看 direct)
    const keys = [...store.keys()].filter((k) => k.startsWith('xxb:activity:lastHumanDirect:'));
    return (async function* () {
      yield keys;
    })();
  }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const { recordHumanMessage, recordBotReply, scanSilentChats } = await import(
  '../../../src/tracking/reply-activity.js'
);

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('reply-activity', () => {
  // 用真实当前时间做锚点(scanSilentChats 内部用 Date.now())
  const T0 = Date.now();
  const min = (n: number): number => n * 60_000;

  it('recordHumanMessage(direct) 写 lastHuman + lastHumanDirect;普通消息只写 lastHuman', async () => {
    recordHumanMessage(123, { direct: true }, new Date(T0));
    recordHumanMessage(456, {}, new Date(T0));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get('xxb:activity:lastHuman:123')).toBe(String(T0));
    expect(store.get('xxb:activity:lastHumanDirect:123')).toBe(String(T0));
    expect(store.get('xxb:activity:lastHuman:456')).toBe(String(T0));
    expect(store.get('xxb:activity:lastHumanDirect:456')).toBeUndefined();
  });

  it('recordBotReply 写 lastReply', async () => {
    recordBotReply(123, new Date(T0));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get('xxb:activity:lastReply:123')).toBe(String(T0));
  });

  it('scanSilentChats:direct 消息 bot 没接 → 命中', async () => {
    const now = T0;
    // 人类 direct 发言 40 分钟前, bot 50 分钟前回过(早于 direct 发言,即没接)
    store.set('xxb:activity:lastHumanDirect:1', String(now - min(40)));
    store.set('xxb:activity:lastReply:1', String(now - min(50)));

    const silent = await scanSilentChats({
      humanStaleMin: 60,
      replyStaleMin: 30,
    });
    expect(silent).toHaveLength(1);
    expect(silent[0]!.chatId).toBe(1);
    expect(silent[0]!.silentForMin).toBe(40);
  });

  it('scanSilentChats:direct 消息后 bot 回过 → 不命中(已接)', async () => {
    // direct 发言 40 分钟前, bot 5 分钟前回过 → bot 接了,之后安静是正常的
    store.set('xxb:activity:lastHumanDirect:1', String(T0 - min(40)));
    store.set('xxb:activity:lastReply:1', String(T0 - min(5)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(0);
  });

  it('scanSilentChats:只有普通群聊消息(无 direct key)→ 不命中(不插话是正常)', async () => {
    // 只有 lastHuman(普通消息),没有 lastHumanDirect —— 模拟群聊没人 @bot
    store.set('xxb:activity:lastHuman:1', String(T0 - min(40)));
    store.set('xxb:activity:lastReply:1', String(T0 - min(50)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(0);
  });

  it('scanSilentChats:direct 消息太旧(潜水)→ 不命中', async () => {
    store.set('xxb:activity:lastHumanDirect:1', String(T0 - min(120))); // 2h 前
    store.set('xxb:activity:lastReply:1', String(T0 - min(200)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(0);
  });

  it('scanSilentChats:direct 活跃但 bot 从未回过 → 命中且 silentForMin 从 direct 算起', async () => {
    store.set('xxb:activity:lastHumanDirect:7', String(T0 - min(40)));
    // 无 lastReply key

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(1);
    expect(silent[0]!.lastReplyAt).toBeNull();
    expect(silent[0]!.silentForMin).toBe(40);
  });

  it('scanSilentChats:Redis 故障 fail-soft 返回空(不误报)', async () => {
    redisMock.ping.mockRejectedValueOnce(new Error('down'));
    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(0);
  });

  it('scanSilentChats:max 上限截断', async () => {
    store.set('xxb:activity:lastHumanDirect:1', String(T0 - min(40)));
    store.set('xxb:activity:lastHumanDirect:2', String(T0 - min(40)));
    store.set('xxb:activity:lastHumanDirect:3', String(T0 - min(40)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30, max: 2 });
    expect(silent.length).toBeLessThanOrEqual(2);
  });
});
