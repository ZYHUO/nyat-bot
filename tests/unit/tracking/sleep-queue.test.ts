import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// in-memory Redis:list + set + multi(链式)子集
const lists = new Map<string, string[]>();
const sets = new Map<string, Set<string>>();
function multiChain(): Record<string, unknown> {
  const ops: (() => void)[] = [];
  const chain = {
    rpush: (k: string, v: string) => { ops.push(() => { lists.set(k, [...(lists.get(k) ?? []), v]); }); return chain; },
    ltrim: (k: string, start: number, stop: number) => {
      ops.push(() => {
        const arr = lists.get(k) ?? [];
        const s = start < 0 ? Math.max(0, arr.length + start) : start;
        const e = stop < 0 ? arr.length + stop : stop;
        lists.set(k, arr.slice(s, e + 1));
      });
      return chain;
    },
    expire: () => chain,
    sadd: (k: string, v: string) => { ops.push(() => { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(v); }); return chain; },
    del: (k: string) => { ops.push(() => { lists.delete(k); }); return chain; },
    srem: (k: string, v: string) => { ops.push(() => { sets.get(k)?.delete(v); }); return chain; },
    exec: async () => { ops.forEach((f) => f()); return []; },
  };
  return chain;
}
const redisMock = {
  multi: () => multiChain(),
  lrange: vi.fn(async (k: string) => lists.get(k) ?? []),
  smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
  srem: vi.fn(async (k: string, v: string) => { sets.get(k)?.delete(v); return 1; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

// 默认所有群可回放(turn actor);单测里临时改成 false 验证非 actor 丢弃
let actorChat = true;
vi.mock('../../../src/pipeline/turn/flags.js', () => ({
  isTurnActorChat: () => actorChat,
}));

const { pushSleepPending, clearSleepPending, listSleepPendingChats, takeSleepPending, peekSleepQueues } =
  await import('../../../src/tracking/sleep-queue.js');

const entry = (messageId: number) => ({
  update: { update_id: messageId } as never,
  chatId: -100,
  messageId,
  enqueuedAt: 0,
});

beforeEach(() => {
  lists.clear();
  sets.clear();
  actorChat = true;
  vi.clearAllMocks();
});

describe('sleep-queue', () => {
  it('push 保最新 3 条 + 维护 chat 索引', async () => {
    for (let i = 1; i <= 5; i++) {
      await pushSleepPending(-100, { entry: entry(i), rule: 'heart', ts: i });
    }
    expect(lists.get('xxb:sleep:pendingq:-100')!.length).toBe(3);
    expect(await listSleepPendingChats()).toEqual([-100]);
  });

  it('非 turn-actor 群不入队、返回 false(回放不出去,别假装攒着)', async () => {
    actorChat = false;
    const ok = await pushSleepPending(-100, { entry: entry(1), rule: 'mention_self', ts: 1 });
    expect(ok).toBe(false);
    expect(lists.get('xxb:sleep:pendingq:-100')).toBeUndefined();
    expect(await listSleepPendingChats()).toEqual([]);
  });

  it('turn-actor 群入队返回 true', async () => {
    expect(await pushSleepPending(-100, { entry: entry(1), rule: 'heart', ts: 1 })).toBe(true);
  });

  it('take:点名规则优先于更新的闲聊;取后清空', async () => {
    await pushSleepPending(-100, { entry: entry(1), rule: 'mention_self', ts: 1 });
    await pushSleepPending(-100, { entry: entry(2), rule: 'heart', ts: 2 });
    const item = await takeSleepPending(-100);
    expect(item!.entry.messageId).toBe(1); // 点名优先,尽管 #2 更新
    expect(await takeSleepPending(-100)).toBeNull();
    expect(await listSleepPendingChats()).toEqual([]);
  });

  it('take:没有点名时取最新', async () => {
    await pushSleepPending(-100, { entry: entry(1), rule: 'heart', ts: 1 });
    await pushSleepPending(-100, { entry: entry(2), rule: 'turn_replan', ts: 2 });
    expect((await takeSleepPending(-100))!.entry.messageId).toBe(2);
  });

  it('clear:被吵醒看过手机 → 欠账清零', async () => {
    await pushSleepPending(-100, { entry: entry(1), rule: 'heart', ts: 1 });
    await clearSleepPending(-100);
    expect(await takeSleepPending(-100)).toBeNull();
    expect(await listSleepPendingChats()).toEqual([]);
  });

  it('peek:有点名的 chat 排前面,其余按最新', async () => {
    await pushSleepPending(-1, { entry: entry(1), rule: 'heart', ts: 100 });
    await pushSleepPending(-2, { entry: entry(2), rule: 'private_chat', ts: 50 });
    await pushSleepPending(-3, { entry: entry(3), rule: 'heart', ts: 200 });
    const peek = await peekSleepQueues();
    expect(peek.map((p) => p.chatId)).toEqual([-2, -3, -1]);
  });
});
