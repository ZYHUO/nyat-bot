import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * round 38：answered 账本必须可读。
 *
 * 起因是 round 37 的发现：重复锚点闸（round 89）全日志只拦 3 次，
 * 而我按它判据从 `host sendText` 日志回放得 **3854** 候选——差 1285 倍。
 *
 * 两个数来源不同：我的回放读发送日志，闸自己读 `answeredTimestamps(chat, anchor)`，
 * 而那个的源是 `markMessageAnswered`——**它此前零打点**。
 * 于是"闸拦得少"这件事实无法定论。
 *
 * 现在这个函数有三条打点。这里验它们真的在，且"非写入"分支比"写入"更受关注
 * （它们正是账本与发送日志对不上的位置）。
 */

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
};

const { incrCounterMock } = vi.hoisted(() => ({ incrCounterMock: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: incrCounterMock }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { markMessageAnswered } = await import('../../../src/meta/answered.js');

const chat = -100;
const mid = 12345;
const namesOf = (): string[] => incrCounterMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  store.clear();
  incrCounterMock.mockClear();
});

describe('answered 账本可读', () => {
  it('① 首次写入：read + written 两个计数', async () => {
    await markMessageAnswered(chat, mid);
    expect(namesOf()).toContain('answered_stamp_read_total');
    expect(namesOf()).toContain('answered_stamp_written_total');
  });

  it('② 同一秒再标一次 → 记 same_second_skipped，**不**写 written（round 132 的去重）', async () => {
    await markMessageAnswered(chat, mid);
    incrCounterMock.mockClear();
    await markMessageAnswered(chat, mid);
    expect(namesOf()).toContain('answered_same_second_skipped_total');
    expect(namesOf()).not.toContain('answered_stamp_written_total');
    // 账本里仍只有一个戳
    expect(store.get(`xxb:meta:answered:${chat}:${mid}`)!.split(',').length).toBe(1);
  });

  it('③ 隔一秒再标 → 两个戳都进账本', async () => {
    await markMessageAnswered(chat, mid);
    // 手工把账本的时间戳往前挪，避免真的 sleep
    store.set(`xxb:meta:answered:${chat}:${mid}`, String(Math.floor(Date.now() / 1000) - 5));
    incrCounterMock.mockClear();
    await markMessageAnswered(chat, mid);
    expect(namesOf()).toContain('answered_stamp_written_total');
    expect(namesOf()).not.toContain('answered_same_second_skipped_total');
    expect(store.get(`xxb:meta:answered:${chat}:${mid}`)!.split(',').length).toBe(2);
  });

  it('④ 旧的 prev === \'1\' 格式单独计数（要知道有多少历史遗留）', async () => {
    store.set(`xxb:meta:answered:${chat}:${mid}`, '1');
    await markMessageAnswered(chat, mid);
    expect(namesOf()).toContain('answered_legacy_format_total');
    // 旧格式要能正常升级成时间戳列表
    expect(store.get(`xxb:meta:answered:${chat}:${mid}`)).not.toBe('1');
  });

  it('⑤ 所有计数器都带 chat label（和 delegation_target_absent_total 同形）', async () => {
    await markMessageAnswered(chat, mid);
    for (const call of incrCounterMock.mock.calls) {
      // incrCounter(name, labels, by) —— labels 是**第二个**参数
      const labels = (call[1] ?? {}) as Record<string, unknown>;
      expect(labels.chat, `${call[0]} 少 chat label`).toBeDefined();
    }
  });

  it('⑥ Redis 出错不炸（markMessageAnswered 是记账，不是发送前提）', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(markMessageAnswered(chat, mid)).resolves.toBeUndefined();
  });
});
