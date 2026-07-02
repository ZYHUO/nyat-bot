import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockCallWithFallback = vi.fn();
const redisStore = new Map<string, string>();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; },
  }),
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: Parameters<typeof mockCallWithFallback>) => mockCallWithFallback(...args),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ REALTIME_LEARN_ENABLED: true, REALTIME_LEARN_TIMEOUT_MS: 10000 }),
}));

import { learnFromReply } from '../../../src/tracking/realtime-learn.js';

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, summary TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '', salience REAL NOT NULL DEFAULT 0.5,
      source_msg_id INTEGER, created_at INTEGER NOT NULL,
      last_recalled_at INTEGER NOT NULL DEFAULT 0, recall_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_relationships (
      chat_id INTEGER NOT NULL, uid INTEGER NOT NULL, affinity REAL NOT NULL DEFAULT 0,
      interaction_count INTEGER NOT NULL DEFAULT 0, last_interaction_at INTEGER NOT NULL,
      last_summary TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, uid)
    );
  `);
}

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });
// 自评分 mock(L3,每条回复都跑,是第 episode/关系 之后的最后一次 callWithFallback)
const selfScoreMock = ok('{"score":0.7}');

// 文本都 ≥24 字(触发+回复合计),越过 L2 短文本守卫。
const TRIG = '我今天就赚了一万块钱你们信不信啊';
const REPLY = '得了吧你吹牛也不打草稿谁信你呀';

beforeEach(() => {
  testDb = new Database(':memory:');
  initSchema(testDb);
  redisStore.clear();
  mockCallWithFallback.mockReset();
});

function episodeCount(chatId: number): number {
  return (testDb.prepare('SELECT COUNT(*) c FROM group_episodes WHERE chat_id = ?').get(chatId) as { c: number }).c;
}

function relSummary(chatId: number, uid: number): { last_summary: string; updated_at: number } {
  return testDb.prepare('SELECT last_summary, updated_at FROM chat_relationships WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { last_summary: string; updated_at: number };
}

describe('learnFromReply (实时学习)', () => {
  // 调用顺序:1=episode 抽取,2=关系刷新(仅 stale>6h 且有行),3=自评分(总跑)

  it('LLM 返回事件 → 写一条 episode(无关系行 → 关系跳过;自评分仍跑)', async () => {
    mockCallWithFallback
      .mockResolvedValueOnce(ok('[{"summary":"老张吹牛赚了一万被拆穿","keywords":"老张 吹牛 赚钱","salience":0.8}]')) // episode
      .mockResolvedValueOnce(selfScoreMock); // 自评分
    await learnFromReply({ chatId: -100, userId: 7, triggerText: TRIG, replyText: REPLY });
    expect(episodeCount(-100)).toBe(1);
    expect(mockCallWithFallback).toHaveBeenCalledTimes(2);
  });

  it('LLM 返回 [](日常寒暄)→ 不写 episode,自评分仍跑', async () => {
    mockCallWithFallback.mockResolvedValueOnce(ok('[]')).mockResolvedValueOnce(selfScoreMock);
    await learnFromReply({ chatId: -100, userId: 7, triggerText: '今天天气真不错啊适合出去走走', replyText: '是呀阳光挺好的我也想出门逛逛' });
    expect(episodeCount(-100)).toBe(0);
    expect(mockCallWithFallback).toHaveBeenCalledTimes(2);
  });

  it('L2:触发+回复太短(<24字)→ 不调 LLM,不写 episode', async () => {
    await learnFromReply({ chatId: -100, userId: 7, triggerText: '嗯', replyText: '哦' });
    expect(mockCallWithFallback).not.toHaveBeenCalled();
    expect(episodeCount(-100)).toBe(0);
  });

  it('关系刷新:行存在且超过 6h → 更新 last_summary(episode+关系+自评 = 3 调)', async () => {
    const stale = Math.floor(Date.now() / 1000) - 7 * 3600;
    testDb.prepare('INSERT INTO chat_relationships (chat_id, uid, interaction_count, last_interaction_at, last_summary, updated_at) VALUES (?,?,?,?,?,?)')
      .run(-100, 7, 20, stale, '旧印象', stale);
    mockCallWithFallback
      .mockResolvedValueOnce(ok('[]')) // episode
      .mockResolvedValueOnce(ok('他总半夜找你聊天')) // 关系刷新
      .mockResolvedValueOnce(selfScoreMock); // 自评分
    await learnFromReply({ chatId: -100, userId: 7, triggerText: '你怎么这么晚还没睡呀不困吗', replyText: '困了就睡嘛别老熬夜对身体不好' });
    expect(relSummary(-100, 7).last_summary).toBe('他总半夜找你聊天');
    expect(mockCallWithFallback).toHaveBeenCalledTimes(3);
  });

  it('关系刷新:行存在但不到 6h → 不刷新(episode+自评 = 2 调,关系跳过)', async () => {
    const fresh = Math.floor(Date.now() / 1000) - 60;
    testDb.prepare('INSERT INTO chat_relationships (chat_id, uid, interaction_count, last_interaction_at, last_summary, updated_at) VALUES (?,?,?,?,?,?)')
      .run(-100, 7, 20, fresh, '旧印象', fresh);
    mockCallWithFallback.mockResolvedValueOnce(ok('[]')).mockResolvedValueOnce(selfScoreMock);
    await learnFromReply({ chatId: -100, userId: 7, triggerText: '你怎么这么晚还没睡呀不困吗', replyText: '困了就睡嘛别老熬夜对身体不好' });
    expect(relSummary(-100, 7).last_summary).toBe('旧印象');
    expect(mockCallWithFallback).toHaveBeenCalledTimes(2); // episode + 自评分,关系未跑
  });

  it('chat_relationships 无行 → 关系跳过,episode 仍写(2 调)', async () => {
    mockCallWithFallback
      .mockResolvedValueOnce(ok('[{"summary":"聊到半夜睡觉的话题","keywords":"半夜 睡觉","salience":0.3}]'))
      .mockResolvedValueOnce(selfScoreMock);
    const saved = await learnFromReply({ chatId: -100, userId: 999, triggerText: '你怎么这么晚还没睡呀不困吗', replyText: '困了就睡嘛别老熬夜对身体不好' });
    expect(saved).toBe(1);
    expect(episodeCount(-100)).toBe(1);
    expect(mockCallWithFallback).toHaveBeenCalledTimes(2);
  });

  it('L3 自评分:写入 per-chat EMA 到 redis', async () => {
    mockCallWithFallback.mockResolvedValueOnce(ok('[]')).mockResolvedValueOnce(ok('{"score":0.9}'));
    await learnFromReply({ chatId: -100, userId: 7, triggerText: TRIG, replyText: REPLY });
    expect(redisStore.get('xxb:reply:selfscore:-100')).toBe('0.9000');
  });

  it('LLM 抛错 → fail-soft,不抛出,不写 episode', async () => {
    mockCallWithFallback.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(selfScoreMock);
    await expect(learnFromReply({ chatId: -100, userId: 7, triggerText: TRIG, replyText: REPLY })).resolves.toBe(0);
    expect(episodeCount(-100)).toBe(0);
  });
});
