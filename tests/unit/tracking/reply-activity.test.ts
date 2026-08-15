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
    // 简易 scanStream:一次性吐出所有 lastHuman key
    const keys = [...store.keys()].filter((k) => k.startsWith('xxb:activity:lastHuman:'));
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

  it('recordHumanMessage/recordBotReply 写入对应 key', async () => {
    recordHumanMessage(123, new Date(T0));
    recordBotReply(123, new Date(T0));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get('xxb:activity:lastHuman:123')).toBe(String(T0));
    expect(store.get('xxb:activity:lastReply:123')).toBe(String(T0));
  });

  it('scanSilentChats:活跃且人类最后发言 bot 没接 → 命中', async () => {
    const now = T0;
    // 人类 40 分钟前发言, bot 50 分钟前回过(早于人类发言,即最后一条没接)
    store.set('xxb:activity:lastHuman:1', String(now - min(40)));
    store.set('xxb:activity:lastReply:1', String(now - min(50)));

    const silent = await scanSilentChats({
      humanStaleMin: 60,
      replyStaleMin: 30,
    });
    expect(silent).toHaveLength(1);
    expect(silent[0]!.chatId).toBe(1);
    expect(silent[0]!.silentForMin).toBe(40);
  });

  it('scanSilentChats:人类最后发言后 bot 回过(潜水群)→ 不命中', async () => {
    // 人类 40 分钟前发言, bot 5 分钟前回过 → bot 接了最后一条,群之后安静是正常的
    store.set('xxb:activity:lastHuman:1', String(T0 - min(40)));
    store.set('xxb:activity:lastReply:1', String(T0 - min(5)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(0);
  });

  it('scanSilentChats:人类消息太旧(潜水群)→ 不命中', async () => {
    store.set('xxb:activity:lastHuman:1', String(T0 - min(120))); // 2h 前有人说话
    store.set('xxb:activity:lastReply:1', String(T0 - min(200)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30 });
    expect(silent).toHaveLength(0);
  });

  it('scanSilentChats:人类活跃但 bot 从未回过 → 命中且 silentForMin 从人类消息算起', async () => {
    store.set('xxb:activity:lastHuman:7', String(T0 - min(40)));
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
    store.set('xxb:activity:lastHuman:1', String(T0 - min(5)));
    store.set('xxb:activity:lastHuman:2', String(T0 - min(5)));
    store.set('xxb:activity:lastHuman:3', String(T0 - min(5)));

    const silent = await scanSilentChats({ humanStaleMin: 60, replyStaleMin: 30, max: 2 });
    expect(silent.length).toBeLessThanOrEqual(2);
  });
});
