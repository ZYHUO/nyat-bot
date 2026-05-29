import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { scoreIntentMatch, getReadyStickersByIntent } = await import(
  '../../../src/knowledge/sticker/store.js'
);

function initSchema(db: Database.Database): void {
  const migrations = ['migrations/0003_stickers.sql', 'migrations/0006_sticker_feedback.sql'];
  for (const m of migrations) {
    db.exec(readFileSync(resolve(process.cwd(), m), 'utf-8'));
  }
}

interface SeedRow {
  fuid: string;
  fileId?: string;
  tags: string[];
  mood?: Record<string, number>;
  userScore?: number;
  personaFit?: number | null;
  status?: string;
}

function seed(db: Database.Database, row: SeedRow): void {
  db.prepare(
    `INSERT INTO sticker_items
       (file_unique_id, latest_file_id, sticker_format, analysis_status,
        persona_fit, emotion_tags, mood_map, user_score)
     VALUES (?, ?, 'static_webp', ?, ?, ?, ?, ?)`,
  ).run(
    row.fuid,
    row.fileId ?? `fid-${row.fuid}`,
    row.status ?? 'ready',
    row.personaFit === undefined ? null : row.personaFit,
    JSON.stringify(row.tags),
    row.mood ? JSON.stringify(row.mood) : null,
    row.userScore ?? 1.0,
  );
}

describe('scoreIntentMatch (pure scoring)', () => {
  it('scores an exact emotion-tag match high (+3)', () => {
    expect(scoreIntentMatch('happy', ['happy'], {})).toBe(3);
  });

  it('scores a synonym match high (intent "happy" → synonym "cheerful")', () => {
    // "cheerful" is a synonym of intent "happy"; exact match against the synonym → +3.
    expect(scoreIntentMatch('happy', ['cheerful'], {})).toBe(3);
  });

  it('awards substring overlap (+1) without triggering the fuzzy fallback', () => {
    // tag "unhappy" contains synonym "happy" → +1 via existing substring pass.
    const score = scoreIntentMatch('happy', ['unhappy'], {});
    expect(score).toBe(1);
  });

  it('scores mood-map key matches (+2)', () => {
    expect(scoreIntentMatch('happy', [], { happy: 0.9 })).toBe(2);
  });

  it('falls back to a small fuzzy score for a close typo (happily → happy)', () => {
    // "happily" is not a known intent (synonyms = ['happily']); it neither equals nor
    // is a substring of "happy", so only the fuzzy pass can match (sim ~0.714 >= 0.7).
    const score = scoreIntentMatch('happily', ['happy'], {});
    expect(score).toBe(1);
  });

  it('fuzzy-matches a typo against an intent synonym (plaful → playful)', () => {
    // "plaful" is not a known intent; "playful" is a synonym of intent "happy".
    // No exact/substring hit, but fuzzy sim("plaful","playful") ~0.857 >= 0.7.
    expect(scoreIntentMatch('plaful', ['playful'], {})).toBe(1);
  });

  it('returns 0 for an unrelated tag (no exact, substring, or fuzzy match)', () => {
    expect(scoreIntentMatch('happy', ['furniture'], {})).toBe(0);
  });

  it('does NOT run the fuzzy pass when an exact/synonym match already exists', () => {
    // Exact "happy" (+3) plus an unrelated-but-close tag "happily"; the fuzzy pass is
    // skipped entirely because score is already > 0, so the total stays exactly 3.
    expect(scoreIntentMatch('happy', ['happy', 'happily'], {})).toBe(3);
  });
});

describe('getReadyStickersByIntent (top-N + relaxed pass)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('caps the returned candidate set at the top-N cutoff (10) and sorts DESC', () => {
    // 15 ready stickers, all exact "happy" match (+3). Vary user_score so the multiplied
    // score is distinct, then assert only the top 10 by score come back, descending.
    for (let i = 0; i < 15; i++) {
      seed(testDb, { fuid: `s${i}`, tags: ['happy'], userScore: (i + 1) / 16 });
    }

    const out = getReadyStickersByIntent('happy');
    expect(out).toHaveLength(10);

    const scores = out.map((c) => c.score);
    const sortedDesc = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sortedDesc);

    // The highest-userScore sticker (s14, userScore 15/16) must be the top result.
    expect(out[0]!.fileUniqueId).toBe('s14');
    // The 10th-best (rank index 9) keeps userScore (15-9)/16 = 6/16; s4 (5/16) is excluded.
    expect(out.map((c) => c.fileUniqueId)).not.toContain('s4');
  });

  it('ignores stickers below the strict user_score floor (0.1) in the primary pass', () => {
    seed(testDb, { fuid: 'strong', tags: ['happy'], userScore: 1.0 });
    seed(testDb, { fuid: 'weak', tags: ['happy'], userScore: 0.05 }); // below 0.1 floor

    const out = getReadyStickersByIntent('happy');
    expect(out.map((c) => c.fileUniqueId)).toEqual(['strong']);
  });

  it('runs a relaxed second pass (user_score > 0.01) only when the strict pass is empty', () => {
    // Only lightly-disliked stickers exist (0.01 < user_score <= 0.1): strict pass yields
    // nothing, so the relaxed pass should surface them instead of returning empty.
    seed(testDb, { fuid: 'lightly', tags: ['happy'], userScore: 0.05 });
    seed(testDb, { fuid: 'dead', tags: ['happy'], userScore: 0.005 }); // below relaxed floor

    const out = getReadyStickersByIntent('happy');
    expect(out.map((c) => c.fileUniqueId)).toEqual(['lightly']);
  });

  it('returns empty when no sticker matches the intent at all', () => {
    seed(testDb, { fuid: 'unrelated', tags: ['furniture'], userScore: 1.0 });
    expect(getReadyStickersByIntent('happy')).toEqual([]);
  });

  it('excludes non-ready and persona_fit=0 stickers', () => {
    seed(testDb, { fuid: 'pending', tags: ['happy'], status: 'pending', userScore: 1.0 });
    seed(testDb, { fuid: 'disabled', tags: ['happy'], personaFit: 0, userScore: 1.0 });
    seed(testDb, { fuid: 'ok', tags: ['happy'], userScore: 1.0 });

    const out = getReadyStickersByIntent('happy');
    expect(out.map((c) => c.fileUniqueId)).toEqual(['ok']);
  });
});
