import { describe, expect, it, vi } from 'vitest';

/**
 * round 167: **sweepStaleAgentTasks 的行为验证**（round 106/114 只做了形状守卫）。
 *
 * Round 166 说"形状守卫比行为弱，但足以防有人改坏形状"。
 * 这轮把行为验证补上——sweepStaleAgentTasks 是导出的，能真调。
 *
 * 三个场景都必须覆盖（round 53 的规矩：为 "∀x∈S, P(x)" 加反例）：
 *   ① 形态 A：status=running 且 age > 2h → 「改 failed + 解索引」（真僵尸）
 *   ② 边界：status=waiting_user 且 age 巨大 → 「不清」（round 67 的边界）
 *   ③ 形态 B：hash 里没有该 task → 「删索引」（纯死键）
 *
 * 少了②，一次重构就能把"等人的任务"也清掉——那比僵尸更糟
 * （用户的下一句话会变成重复 dispatch）。
 */

interface FakeRedis {
  store: Map<string, string>;
  hash: Map<string, Map<string, string>>;
  keys: (p: string) => Promise<string[]>;
  get: (k: string) => Promise<string | null>;
  del: (k: string) => Promise<number>;
  hget: (h: string, f: string) => Promise<string | null>;
  hset: (h: string, f: string, v: string) => Promise<number>;
}

const makeRedis = (): FakeRedis => {
  const store = new Map<string, string>();
  const hash = new Map<string, Map<string, string>>();
  return {
    store, hash,
    keys: async (p) => {
      const pre = p.replace(/\*$/, '');
      return [...store.keys()].filter((k) => k.startsWith(pre));
    },
    get: async (k) => store.get(k) ?? null,
    del: async (k) => (store.delete(k) ? 1 : 0),
    hget: async (h, f) => hash.get(h)?.get(f) ?? null,
    hset: async (h, f, v) => {
      if (!hash.has(h)) hash.set(h, new Map());
      hash.get(h)!.set(f, v);
      return 1;
    },
  };
};

// round 67: mock 必须实际改状态，否则测试断的是"调用了多少次"
// 而不是"故障真的清理了。第一片我用空 spy，结果
// expect(await fake.get(KEY)).toBeNull() 失败——那是我的 mock 太弱，不是代码的错。
const unregisterSpy = vi.fn(async (chatId: number, taskId: string) => {
  const k = `xxb:agent:active-chat:${chatId}`;
  if (fake.store.get(k) === taskId) fake.store.delete(k);
});
const persistSpy = vi.fn(async (t: { id: string; status: string }) => {
  fake.hash.get('xxb:codeact:tasks')?.set(t.id, JSON.stringify(t));
});

vi.mock('../../../src/db/redis.js', () => ({ getRedis: (): unknown => fake }));
vi.mock('../../../src/agent/checkpoint.js', () => ({ unregisterAgentChat: (...a: unknown[]) => unregisterSpy(...a) }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  // round 67: 真的 loadCodeActTask 返回 JSON.parse 后的对象；
  // mock 直接返回字符串会认为所有任务状态都不是 running
  // （t.status 为 undefined）→ 全不清——我第一片就是这样，现象是"checked 1 cleared 0"。
  loadCodeActTask: async (id: string) => {
    const raw = fake.hash.get('xxb:codeact:tasks')?.get(id);
    return raw ? (JSON.parse(raw) as unknown) : null;
  },
  persistCodeActTask: (...a: unknown[]) => persistSpy(...a),
}));

const fake = makeRedis();

const { sweepStaleAgentTasks } = await import('../../../src/cron/restart-hygiene.js');

const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CHAT = -1001234567890;
const KEY = `xxb:agent:active-chat:${CHAT}`;
const HASH = 'xxb:codeact:tasks';

const seedTask = (status: string, ageSec: number): void => {
  if (!fake.hash.has(HASH)) fake.hash.set(HASH, new Map());
  fake.hash.get(HASH)!.set(TASK_ID, JSON.stringify({
    id: TASK_ID, chatId: CHAT, status, createdAt: Math.floor(Date.now() / 1000) - ageSec,
  }));
};

describe('sweepStaleAgentTasks 的行为', () => {
  it('① 形态 A：running 且 age>2h → 改 failed + 解索引', async () => {
    fake.store.clear(); fake.hash.clear(); unregisterSpy.mockClear(); persistSpy.mockClear();
    fake.store.set(KEY, TASK_ID);
    seedTask('running', 3 * 3600);           // 3 小时 > 2 小时阈值
    const r = await sweepStaleAgentTasks();
    expect(r.checked).toBe(1);
    expect(r.cleared.length).toBe(1);
    expect(await fake.get(KEY)).toBeNull();                    // 索引解掉
    const after = JSON.parse(fake.hash.get(HASH)!.get(TASK_ID)!);
    expect(after.status).toBe('failed');                       // 状态改掉
    expect(unregisterSpy).toHaveBeenCalledWith(CHAT, TASK_ID);
  });

  it('② 边界：waiting_user 且 age 巨大 → 不清', async () => {
    fake.store.clear(); fake.hash.clear(); unregisterSpy.mockClear();
    fake.store.set(KEY, TASK_ID);
    seedTask('waiting_user', 99 * 3600);      // 99 小时，远超阈值
    const r = await sweepStaleAgentTasks();
    expect(r.checked).toBe(1);
    expect(r.cleared.length, '等人的任务被清了——那比僵尸更糟').toBe(0);
    expect(await fake.get(KEY)).toBe(TASK_ID);                 // 索引还在
    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it('③ 边界：running 但 age < 2h → 不清（别削掉正在跑的长任务）', async () => {
    fake.store.clear(); fake.hash.clear();
    fake.store.set(KEY, TASK_ID);
    seedTask('running', 30 * 60);             // 30 分钟
    const r = await sweepStaleAgentTasks();
    expect(r.cleared.length).toBe(0);
    expect(await fake.get(KEY)).toBe(TASK_ID);
  });

  it('④ 形态 B：hash 里没有该 task → 删索引', async () => {
    fake.store.clear(); fake.hash.clear();
    fake.store.set(KEY, TASK_ID);
    // 不 seedTask —— 纯死键
    const r = await sweepStaleAgentTasks();
    expect(r.cleared.length).toBe(1);
    expect(r.cleared[0]).toContain('task gone');
    expect(await fake.get(KEY)).toBeNull();
  });

  it('⑤ 空索引 → checked 0 cleared 0，且不抛', async () => {
    fake.store.clear(); fake.hash.clear();
    const r = await sweepStaleAgentTasks();
    expect(r).toEqual({ cleared: [], checked: 0 });
  });
});
