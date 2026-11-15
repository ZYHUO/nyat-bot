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
const envValues: Record<string, unknown> = {
  ASI_USAGE: 'asi',
  ASI_RUBRIC_MAX_TOKENS: 1200,
  ASI_SAMPLE_RATE: 0.2,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

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
  envValues.ASI_USAGE = 'asi';
  envValues.ASI_RUBRIC_MAX_TOKENS = 1200;
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

  it('rubric LLM 抛错 → fail-soft,不抛出', async () => {
    mockCallWithFallback.mockRejectedValue(new Error('boom'));
    await expect(scoreReplyAtSend({ chatId: -100, triggerText: 'q', replyText: 'a', signal: 'sent' })).resolves.toBeUndefined();
  });
});

// ─── 2026-09-21：rubric 十个月来一次都没测到过 ────────────────────────────
//
// 两个原因叠加：maxTokens=120（reasoning 模型，思维链吃光 → 空 content），
// 以及 judge usage 的 label 是 FORMAT=claude → 走 callClaude，不吃
// response_format，模型回中文 markdown 评语而不是 JSON。
// 结果是 parseRubric 恒返回 null，`eff` 恒为中性默认值，而它被当成测量结果
// 写进了 reply_outcomes——库里 2070 行一模一样 (0.5,0.5,0.5,0.5,0.2,77.0)。
//
// 这里锁三件事：路由到 asi usage、maxTokens 够大、**测不到就不写数**。
describe('ASI rubric 真的在测（不是把中性默认值当测量结果）', () => {
  it('路由到 ASI_USAGE，maxTokens 用 ASI_RUBRIC_MAX_TOKENS，显式 jsonMode', async () => {
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.8,"warmth":0.7,"competence":0.6,"appropriateness":0.9,"uncanny_risk":0.1}'));
    await scoreReplyAtSend({ chatId: -100, triggerText: 'q', replyText: 'a', signal: 'sent' });
    const arg = mockCallWithFallback.mock.calls[0]![0] as {
      usage: string; maxTokens: number; jsonMode?: boolean;
    };
    expect(arg.usage).toBe('asi');
    expect(arg.maxTokens).toBe(1200);
    expect(arg.jsonMode).toBe(true);
  });

  it('ASI_USAGE 可配（换 label 不用改代码）', async () => {
    envValues.ASI_USAGE = 'judge';
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.8,"warmth":0.7,"competence":0.6,"appropriateness":0.9,"uncanny_risk":0.1}'));
    await scoreReplyAtSend({ chatId: -100, triggerText: 'q', replyText: 'a', signal: 'sent' });
    expect((mockCallWithFallback.mock.calls[0]![0] as { usage: string }).usage).toBe('judge');
  });

  it('**模型回中文 markdown（不是 JSON）→ 不写分、不滚 EMA**', async () => {
    const rowId = insertRow();
    mockCallWithFallback.mockResolvedValue(ok('### 1. 意图匹配度：5分\n### 2. 自然度：4分'));
    await persistReplyOutcomeScores({ chatId: -100, rowId, triggerText: 'q', replyText: 'a', signal: 'user_replied' });
    const row = testDb.prepare('SELECT rubric_warmth, asi_final FROM reply_outcomes WHERE id = ?').get(rowId) as {
      rubric_warmth: number | null; asi_final: number | null;
    };
    // 关键：**NULL，不是 0.5 / 77.0**。假度量比没度量更坏。
    expect(row.rubric_warmth).toBeNull();
    expect(row.asi_final).toBeNull();
    expect(redisStore.size).toBe(0); // 没测到就不滚 EMA
  });

  it('空 content → 同样不写分', async () => {
    const rowId = insertRow();
    mockCallWithFallback.mockResolvedValue(ok(''));
    await persistReplyOutcomeScores({ chatId: -100, rowId, triggerText: 'q', replyText: 'a', signal: 'user_replied' });
    const row = testDb.prepare('SELECT rubric_warmth, asi_final FROM reply_outcomes WHERE id = ?').get(rowId) as {
      rubric_warmth: number | null; asi_final: number | null;
    };
    expect(row.rubric_warmth).toBeNull();
    expect(row.asi_final).toBeNull();
  });

  it('LLM 抛错 → 不写分、不滚 EMA（不再把中性值 Averaging 进 EMA）', async () => {
    const rowId = insertRow();
    mockCallWithFallback.mockRejectedValue(new Error('boom'));
    await persistReplyOutcomeScores({ chatId: -100, rowId, triggerText: 'q', replyText: 'a', signal: 'user_replied' });
    const row = testDb.prepare('SELECT rubric_warmth, asi_final FROM reply_outcomes WHERE id = ?').get(rowId) as {
      rubric_warmth: number | null; asi_final: number | null;
    };
    expect(row.rubric_warmth).toBeNull();
    expect(redisStore.size).toBe(0);
  });

  it('测到了 → 照写实测值；不同的 rubric 给出不同的 asi_final', async () => {
    // 注意：asi_final 主要由 signal 导出的 behavior/relational 决定，rubric 只通过
    // uncanny_risk 进 friction。所以"是不是常量"要看**两列一起**——
    // 旧 bug 是 rubric 五列恒定 0.5/0.5/0.5/0.5/0.2，那才是假度量的指纹。
    const a = insertRow();
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.31,"warmth":0.72,"competence":0.44,"appropriateness":0.88,"uncanny_risk":0.19}'));
    await persistReplyOutcomeScores({ chatId: -100, rowId: a, triggerText: 'q', replyText: 'a', signal: 'user_replied' });
    const rowA = testDb.prepare('SELECT rubric_warmth, rubric_uncanny_risk, asi_final FROM reply_outcomes WHERE id = ?').get(a) as {
      rubric_warmth: number; rubric_uncanny_risk: number; asi_final: number;
    };
    expect(rowA.rubric_warmth).toBeCloseTo(0.72);
    expect(rowA.rubric_uncanny_risk).toBeCloseTo(0.19);

    const b = insertRow();
    mockCallWithFallback.mockResolvedValue(ok('{"social_presence":0.05,"warmth":0.11,"competence":0.2,"appropriateness":0.3,"uncanny_risk":0.95}'));
    await persistReplyOutcomeScores({ chatId: -100, rowId: b, triggerText: 'q', replyText: 'a', signal: 'user_replied' });
    const rowB = testDb.prepare('SELECT rubric_warmth, rubric_uncanny_risk, asi_final FROM reply_outcomes WHERE id = ?').get(b) as {
      rubric_warmth: number; rubric_uncanny_risk: number; asi_final: number;
    };
    // 同样的 signal，不同的 rubric → 不同的 uncanny_risk → 不同的 friction → 不同的 asi
    expect(rowB.rubric_warmth).toBeCloseTo(0.11);
    expect(rowB.asi_final).toBeLessThan(rowA.asi_final);
  });

  it('摩擦信号是确定性事实，与 rubric 无关——测不到也照写', async () => {
    const rowId = insertRow();
    mockCallWithFallback.mockResolvedValue(ok('不是 JSON'));
    await persistReplyOutcomeScores({ chatId: -100, rowId, triggerText: 'q', replyText: 'a', signal: 'explicit_negative' });
    const row = testDb.prepare('SELECT friction_explicit_negative, friction_repair_loop, rubric_warmth FROM reply_outcomes WHERE id = ?').get(rowId) as {
      friction_explicit_negative: number; friction_repair_loop: number; rubric_warmth: number | null;
    };
    expect(row.friction_explicit_negative).toBe(1);
    expect(row.rubric_warmth).toBeNull();
  });
});
