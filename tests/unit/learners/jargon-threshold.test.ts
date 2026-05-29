import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  getJargonsForInference,
  markJargonInferred,
  markJargonNoInfo,
  JARGON_INFERENCE_THRESHOLDS,
} = await import('../../../src/learners/jargon-miner.js');

function initSchema(db: Database.Database): void {
  for (const m of ['migrations/0016_learners.sql', 'migrations/0026_jargon_inference.sql']) {
    db.exec(readFileSync(resolve(process.cwd(), m), 'utf-8'));
  }
}

let nextId = 1;
function insertJargon(opts: {
  chatId: number;
  content: string;
  count: number;
  lastInferenceCount?: number;
  meaning?: string;
  status?: string;
}): void {
  const now = Math.floor(Date.now() / 1000);
  testDb
    .prepare(
      `INSERT INTO jargons
         (id, chat_id, content, raw_samples, meaning, count, status, last_inference_count, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nextId++,
      opts.chatId,
      opts.content,
      opts.meaning ?? '',
      opts.count,
      opts.status ?? 'pending',
      opts.lastInferenceCount ?? 0,
      now,
      now,
    );
}

const CHAT = -1001;

describe('jargon inference thresholds', () => {
  beforeEach(() => {
    nextId = 1;
    testDb = new Database(':memory:');
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  it('exposes the documented threshold tiers', () => {
    expect(JARGON_INFERENCE_THRESHOLDS).toEqual([4, 8, 25, 100]);
  });

  it('returns only jargons that have crossed at least the lowest tier', () => {
    insertJargon({ chatId: CHAT, content: 'below', count: 3 }); // < 4, never crossed
    insertJargon({ chatId: CHAT, content: 'at-first', count: 4 }); // crosses tier 4
    insertJargon({ chatId: CHAT, content: 'higher', count: 9 }); // crosses tier 8

    const got = getJargonsForInference(CHAT).map((j) => j.content).sort();
    expect(got).toEqual(['at-first', 'higher']);
  });

  it('does not re-infer at the same tier (last_inference_count blocks it)', () => {
    // count=5 sits in the [4,8) band; already inferred at count 4 => same tier.
    insertJargon({
      chatId: CHAT,
      content: 'same-tier',
      count: 5,
      lastInferenceCount: 4,
      meaning: '旧含义',
      status: 'inferred',
    });
    expect(getJargonsForInference(CHAT)).toHaveLength(0);
  });

  it('re-infers once a jargon climbs into the NEXT tier', () => {
    // inferred at 4 (tier 4); now count=9 has crossed tier 8 => eligible again.
    insertJargon({
      chatId: CHAT,
      content: 'crossed-up',
      count: 9,
      lastInferenceCount: 4,
      meaning: '旧含义',
      status: 'inferred',
    });
    const got = getJargonsForInference(CHAT).map((j) => j.content);
    expect(got).toEqual(['crossed-up']);
  });

  it('never re-infers confirmed jargons', () => {
    insertJargon({
      chatId: CHAT,
      content: 'locked',
      count: 200,
      lastInferenceCount: 0,
      status: 'confirmed',
    });
    expect(getJargonsForInference(CHAT)).toHaveLength(0);
  });

  it('respects a caller-supplied threshold list', () => {
    insertJargon({ chatId: CHAT, content: 'x', count: 6 });
    // With tiers [10] the count 6 has not crossed anything.
    expect(getJargonsForInference(CHAT, [10])).toHaveLength(0);
    // With tiers [5] it has.
    expect(getJargonsForInference(CHAT, [5]).map((j) => j.content)).toEqual(['x']);
  });

  it('markJargonInferred sets meaning, status, and last_inference_count = count', () => {
    insertJargon({ chatId: CHAT, content: 'term', count: 12 });
    markJargonInferred(CHAT, 'term', '某含义');

    const row = testDb
      .prepare('SELECT meaning, status, last_inference_count, count FROM jargons WHERE chat_id = ? AND content = ?')
      .get(CHAT, 'term') as { meaning: string; status: string; last_inference_count: number; count: number };

    expect(row.meaning).toBe('某含义');
    expect(row.status).toBe('inferred');
    expect(row.last_inference_count).toBe(12);
    // After inference, the same tier no longer re-triggers.
    expect(getJargonsForInference(CHAT)).toHaveLength(0);
  });

  it('markJargonNoInfo bumps last_inference_count without overwriting meaning', () => {
    insertJargon({
      chatId: CHAT,
      content: 'term',
      count: 9,
      lastInferenceCount: 4,
      meaning: '已有含义',
      status: 'inferred',
    });
    markJargonNoInfo(CHAT, 'term');

    const row = testDb
      .prepare('SELECT meaning, status, last_inference_count FROM jargons WHERE chat_id = ? AND content = ?')
      .get(CHAT, 'term') as { meaning: string; status: string; last_inference_count: number };

    expect(row.meaning).toBe('已有含义'); // preserved
    expect(row.status).toBe('inferred'); // preserved
    expect(row.last_inference_count).toBe(9); // advanced to current count
    // And it is no longer eligible at this tier.
    expect(getJargonsForInference(CHAT)).toHaveLength(0);
  });
});
