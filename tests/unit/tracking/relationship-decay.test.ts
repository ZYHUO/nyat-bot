import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Relationship feature must be ON for getRelationship to read the DB.
vi.mock('../../../src/env.js', () => ({
  env: () => ({ RELATIONSHIP_ENABLED: true, RELATIONSHIP_INJECT_THRESHOLD: 20 }),
}));

const { getRelationship, affinityBucket } = await import(
  '../../../src/tracking/relationship.js'
);

function initSchema(db: Database.Database): void {
  // 0018 creates chat_relationships standalone (no dependency migrations).
  db.exec(
    readFileSync(
      resolve(process.cwd(), 'migrations/0018_self_history_relationship.sql'),
      'utf-8',
    ),
  );
}

const nowSec = () => Math.floor(Date.now() / 1000);

function insertRel(
  chatId: number,
  uid: number,
  affinity: number,
  lastInteractionAt: number,
): void {
  testDb
    .prepare(
      `INSERT INTO chat_relationships
       (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chatId, uid, affinity, 42, lastInteractionAt, '', lastInteractionAt);
}

// Mirror of the const in relationship.ts (per-hour decay rate).
const RATE = 0.002;
const expectedDecay = (v: number, hours: number) =>
  v * Math.pow(1 - RATE, hours);

describe('relationship affinity time-decay (read-side)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  it('decays a high affinity that has gone stale and recomputes the bucket', () => {
    // 90 affinity (bucket 亲近), last interaction ~30 days ago.
    const hoursStale = 24 * 30; // 720h
    insertRel(-100, 7, 90, nowSec() - hoursStale * 3600);

    const state = getRelationship(-100, 7);
    const want = expectedDecay(90, hoursStale); // ≈ 90 * 0.998^720 ≈ 21.3

    // Decayed below the stored value.
    expect(state.affinity).toBeLessThan(90);
    expect(state.affinity).toBeCloseTo(want, 1);
    // Bucket recomputed from the decayed value (90→亲近, but decayed ≈21 →熟人).
    expect(state.bucket).toBe(affinityBucket(want));
    expect(state.bucket).toBe('熟人');
    // Stored row is untouched (read-side only).
    const raw = testDb
      .prepare('SELECT affinity FROM chat_relationships WHERE chat_id = ? AND uid = ?')
      .get(-100, 7) as { affinity: number };
    expect(raw.affinity).toBe(90);
  });

  it('leaves a fresh interaction essentially undecayed', () => {
    insertRel(-100, 8, 90, nowSec()); // interacted right now

    const state = getRelationship(-100, 8);
    expect(state.affinity).toBeCloseTo(90, 5);
    expect(state.bucket).toBe('亲近');
  });

  it('decays negative affinity toward 0 as well', () => {
    const hoursStale = 24 * 60; // 1440h
    insertRel(-100, 9, -80, nowSec() - hoursStale * 3600);

    const state = getRelationship(-100, 9);
    const want = expectedDecay(-80, hoursStale); // negative, magnitude shrinks toward 0
    expect(state.affinity).toBeGreaterThan(-80); // closer to 0
    expect(state.affinity).toBeLessThan(0);
    expect(state.affinity).toBeCloseTo(want, 1);
    expect(state.bucket).toBe(affinityBucket(want));
  });

  it('returns neutral default for an unknown (chat,uid)', () => {
    const state = getRelationship(-100, 999);
    expect(state).toEqual({ affinity: 0, count: 0, bucket: '一般', lastSummary: '' });
  });
});
