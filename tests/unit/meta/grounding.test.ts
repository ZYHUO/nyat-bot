/**
 * grounding.ts — 启发式触发 / 脱敏 / Redis 存取 / 无证据丢弃 / 限流。
 * Redis 手 mock（Map -backed），executeSearch / callWithFallback mock。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// env flags per-test mutable
const envState = { GROUNDING_ENABLED: true, GROUNDING_USAGE: 'judge' };
vi.mock('../../../src/env.js', () => ({ env: () => envState }));

// Hand-mocked Redis (Map-backed strings + counters)
const store = new Map<string, string>();
const counters = new Map<string, number>();
const redisMock = {
  incr: vi.fn(async (key: string) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return n;
  }),
  expire: vi.fn(async () => 1),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const executeSearch = vi.fn();
vi.mock('../../../src/pipeline/tools/search.js', () => ({
  executeSearch: (...args: unknown[]) => executeSearch(...args),
}));

const callWithFallback = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallback(...args),
}));

import {
  isGroundingPending,
  looksFactualQuestion,
  maybeStartGrounding,
  sanitizeForGrounding,
  takeGrounding,
} from '../../../src/meta/grounding.js';

const EVIDENCE = '关于"新政策"的搜索结果：\n该政策确有其事，已于上月发布。\n来源：某新闻网';

describe('looksFactualQuestion heuristic', () => {
  it('accepts question with ？', () => {
    expect(looksFactualQuestion('最新的 iPhone 什么时候发布？')).toBe(true);
  });

  it('accepts question-word text without question mark', () => {
    expect(looksFactualQuestion('2024年诺贝尔物理学奖颁给了谁')).toBe(true);
    expect(looksFactualQuestion('你知道上个月新能源车卖了多少台')).toBe(true);
    expect(looksFactualQuestion('网上说的那个新政策是不是真的有')).toBe(true);
  });

  it('rejects short pings even with question mark', () => {
    expect(looksFactualQuestion('真的吗？')).toBe(false);
    expect(looksFactualQuestion('在吗')).toBe(false);
    expect(looksFactualQuestion('谁？')).toBe(false);
  });

  it('rejects casual chat without question words', () => {
    expect(looksFactualQuestion('哈哈哈哈我们今天出去玩吧喵')).toBe(false);
    expect(looksFactualQuestion('好困啊先去睡了一会儿再聊')).toBe(false);
  });

  it('rejects empty / blank text', () => {
    expect(looksFactualQuestion('')).toBe(false);
    expect(looksFactualQuestion('   ')).toBe(false);
  });
});

describe('sanitizeForGrounding', () => {
  it('strips @mentions and uid traces, keeps factual core', () => {
    const out = sanitizeForGrounding('@Zh_Taiwan 听说 uid:6251541967 说的那个什么新政策是真的吗');
    expect(out).not.toContain('@');
    expect(out).not.toContain('Zh_Taiwan');
    expect(out).not.toContain('6251541967');
    expect(out).not.toMatch(/uid/i);
    expect(out).toContain('什么新政策是真的吗');
  });

  it('maps uid= form to 某人', () => {
    const out = sanitizeForGrounding('uid=123456 刚才说现在汇率多少了');
    expect(out).not.toContain('123456');
    expect(out).toContain('某人');
    expect(out).toContain('汇率多少');
  });

  it('strips bracket timestamps', () => {
    const out = sanitizeForGrounding('[12:30] 谁说今天全市停课了？[2024-01-01 12:00]');
    expect(out).not.toContain('[12:30]');
    expect(out).not.toContain('2024-01-01');
    expect(out).toContain('谁说今天全市停课了？');
  });
});

describe('maybeStartGrounding / takeGrounding', () => {
  beforeEach(() => {
    store.clear();
    counters.clear();
    vi.clearAllMocks();
    envState.GROUNDING_ENABLED = true;
    executeSearch.mockResolvedValue(EVIDENCE);
    callWithFallback.mockResolvedValue({ content: '是的，该新政策确有其事，上月已发布。' });
  });

  it('stores digest and takeGrounding reads+deletes it (one-shot)', async () => {
    await maybeStartGrounding({ chatId: -100, messageId: 42, text: '最新的 iPhone 什么时候发布？' });

    expect(executeSearch).toHaveBeenCalledTimes(1);
    expect(callWithFallback).toHaveBeenCalledTimes(1);
    expect(callWithFallback.mock.calls[0]?.[0]).toMatchObject({ usage: 'judge', maxTokens: 300 });

    const digest = await takeGrounding(-100, 42);
    expect(digest).toBe('是的，该新政策确有其事，上月已发布。');
    // one-shot: second take returns null
    expect(await takeGrounding(-100, 42)).toBeNull();
    // pending marker cleaned up
    expect(await isGroundingPending(-100, 42)).toBe(false);
  });

  it('searches with the sanitized query (no @/uid leakage)', async () => {
    await maybeStartGrounding({
      chatId: -100,
      messageId: 7,
      text: '@小明 听说 uid:998877 讲那个什么补贴是真的吗',
    });
    const q = executeSearch.mock.calls[0]?.[0] as string;
    expect(q).not.toContain('@');
    expect(q).not.toContain('小明'); // 整个 @mention 被剥掉
    expect(q).not.toContain('998877');
    expect(q).toContain('什么补贴是真的吗');
  });

  it('stores nothing when search has no evidence', async () => {
    executeSearch.mockResolvedValue('没有找到与"xxx"相关的结果。');
    await maybeStartGrounding({ chatId: -100, messageId: 8, text: '某地昨天是不是地震了？' });
    expect(callWithFallback).not.toHaveBeenCalled();
    expect(await takeGrounding(-100, 8)).toBeNull();

    executeSearch.mockResolvedValue('搜索失败: boom');
    await maybeStartGrounding({ chatId: -100, messageId: 9, text: '某地昨天是不是又地震了？' });
    expect(await takeGrounding(-100, 9)).toBeNull();
  });

  it('stores nothing when LLM returns empty digest', async () => {
    callWithFallback.mockResolvedValue({ content: '  ' });
    await maybeStartGrounding({ chatId: -100, messageId: 10, text: '今年的假期安排出来了吗？' });
    expect(await takeGrounding(-100, 10)).toBeNull();
  });

  it('rate-limits to 3 runs per chat per window', async () => {
    const text = '最新的 iPhone 什么时候发布？';
    for (let i = 1; i <= 5; i++) {
      await maybeStartGrounding({ chatId: -200, messageId: i, text });
    }
    expect(executeSearch).toHaveBeenCalledTimes(3);
    // 前 3 次有 digest，后 2 次没有
    expect(await takeGrounding(-200, 3)).not.toBeNull();
    expect(await takeGrounding(-200, 4)).toBeNull();
  });

  it('does nothing when GROUNDING_ENABLED is off', async () => {
    envState.GROUNDING_ENABLED = false;
    await maybeStartGrounding({ chatId: -100, messageId: 42, text: '最新的 iPhone 什么时候发布？' });
    expect(redisMock.incr).not.toHaveBeenCalled();
    expect(executeSearch).not.toHaveBeenCalled();
    expect(await takeGrounding(-100, 42)).toBeNull();
  });

  it('skips messages that fail the heuristic or sanitize to nothing', async () => {
    await maybeStartGrounding({ chatId: -100, messageId: 1, text: '哈哈哈哈我们今天出去玩吧喵' });
    // 脱敏后过短：@mention + uid 剥完只剩「谁？」
    await maybeStartGrounding({ chatId: -100, messageId: 2, text: '@abcdefg 谁 uid:12345？' });
    expect(executeSearch).not.toHaveBeenCalled();
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('never throws when redis/search blow up (fail-soft)', async () => {
    redisMock.incr.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      maybeStartGrounding({ chatId: -100, messageId: 3, text: '最新的 iPhone 什么时候发布？' }),
    ).resolves.toBeUndefined();

    executeSearch.mockRejectedValueOnce(new Error('search boom'));
    await expect(
      maybeStartGrounding({ chatId: -100, messageId: 4, text: '最新的 iPhone 什么时候发布？' }),
    ).resolves.toBeUndefined();
    expect(await takeGrounding(-100, 4)).toBeNull();
    // pending marker still cleaned up after failure
    expect(await isGroundingPending(-100, 4)).toBe(false);
  });
});
