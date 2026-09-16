import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockCallWithFallback = vi.fn();

// 极简 redis double:set/get/del
const redisStore = new Map<string, string>();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; },
    del: async (k: string) => { redisStore.delete(k); return 1; },
  }),
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: Parameters<typeof mockCallWithFallback>) => mockCallWithFallback(...args),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { scoreReplyAtSend, persistReplyOutcomeScores, scoreReplyQuality } from '../../../src/tracking/asi-scoring.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE reply_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rubric_social_presence REAL, rubric_warmth REAL, rubric_competence REAL,
      rubric_appropriateness REAL, rubric_uncanny_risk REAL,
      friction_explicit_negative INTEGER, friction_repair_loop INTEGER, asi_final REAL
    );
  `);
  redisStore.clear();
  mockCallWithFallback.mockReset();
});

function insertRow(): number {
  return Number(testDb.prepare('INSERT INTO reply_outcomes DEFAULT VALUES').run().lastInsertRowid);
}

describe('ASI 自评(L3 拆分)', () => {
  it('scoreReplyAtSend:跑 rubric + 滚 EMA,不写 reply_outcomes', async () => {
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.8,"warmth":0.7,"competence":0.6,"appropriateness":0.9,"uncanny_risk":0.1}'));
    await scoreReplyAtSend({ chatId: -100, triggerText: '在吗', replyText: '在的喵', signal: 'sent' });
    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    // EMA 写进 redis(asi + uncanny 两个 key)
    expect(redisStore.size).toBeGreaterThanOrEqual(2);
    // 不持久化行
    expect(testDb.prepare('SELECT COUNT(*) c FROM reply_outcomes').get()).toEqual({ c: 0 });
  });

  it('persistReplyOutcomeScores:跑 rubric + 写行,不滚 EMA', async () => {
    const rowId = insertRow();
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.8,"warmth":0.7,"competence":0.6,"appropriateness":0.9,"uncanny_risk":0.1}'));
    await persistReplyOutcomeScores({ chatId: -100, rowId, triggerText: '在吗', replyText: '在的喵', signal: 'user_replied' });
    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    expect(redisStore.size).toBe(0); // 不滚 EMA
    const row = testDb.prepare('SELECT asi_final, rubric_warmth FROM reply_outcomes WHERE id = ?').get(rowId) as { asi_final: number; rubric_warmth: number };
    expect(row.asi_final).toBeGreaterThan(0);
    expect(row.rubric_warmth).toBeCloseTo(0.7);
  });

  it('scoreReplyQuality(legacy):既写行又滚 EMA', async () => {
    const rowId = insertRow();
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.5,"warmth":0.5,"competence":0.5,"appropriateness":0.5,"uncanny_risk":0.2}'));
    await scoreReplyQuality({ chatId: -100, rowId, triggerText: 'q', replyText: 'a', signal: 'user_replied' });
    expect(redisStore.size).toBeGreaterThanOrEqual(2);
    expect((testDb.prepare('SELECT asi_final FROM reply_outcomes WHERE id = ?').get(rowId) as { asi_final: number }).asi_final).toBeGreaterThan(0);
  });

  it('rubric LLM 抛错 → fail-soft,用中性 rubric,不抛出', async () => {
    mockCallWithFallback.mockRejectedValue(new Error('boom'));
    await expect(scoreReplyAtSend({ chatId: -100, triggerText: 'q', replyText: 'a', signal: 'sent' })).resolves.toBeUndefined();
    expect(redisStore.size).toBeGreaterThanOrEqual(2); // 中性 rubric 仍滚 EMA
  });
});
