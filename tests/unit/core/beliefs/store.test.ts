import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  upsertBelief,
  getActiveBeliefs,
  recordOutcome,
} from '../../../../src/core/beliefs/store.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
});

describe('belief view', () => {
  it('upserts with evidence and starts at confidence 0.5', () => {
    const id = upsertBelief({
      sourceTable: 'user_profiles',
      sourceRowId: 1,
      predicate: 'person.interest',
      summary: '小明喜欢川菜',
      evidence: ['msg:123'],
    });
    expect(id).toBeGreaterThan(0);
    const row = db.prepare('SELECT * FROM core_beliefs WHERE id=?').get(id) as {
      confidence: number;
      status: string;
    };
    expect(row.confidence).toBe(0.5);
    expect(row.status).toBe('active');
  });

  it('rejects beliefs without evidence', () => {
    expect(() =>
      upsertBelief({ sourceTable: 'x', sourceRowId: 1, predicate: 'p', summary: 's', evidence: [] }),
    ).toThrow(/evidence/);
  });

  it('same source+predicate updates instead of inserting', () => {
    const id1 = upsertBelief({
      sourceTable: 'x',
      sourceRowId: 1,
      predicate: 'p',
      summary: 'v1',
      evidence: ['msg:1'],
    });
    const id2 = upsertBelief({
      sourceTable: 'x',
      sourceRowId: 1,
      predicate: 'p',
      summary: 'v2',
      evidence: ['msg:2'],
    });
    expect(id2).toBe(id1);
    expect((db.prepare('SELECT COUNT(*) c FROM core_beliefs').get() as { c: number }).c).toBe(1);
  });

  it('recordOutcome updates confidence via laplace (host only)', () => {
    const id = upsertBelief({
      sourceTable: 'x',
      sourceRowId: 1,
      predicate: 'p',
      summary: 's',
      evidence: ['msg:1'],
    })!;
    recordOutcome(id, true);
    recordOutcome(id, true);
    // (2+1)/(2+0+2) = 0.75
    expect(
      (db.prepare('SELECT confidence FROM core_beliefs WHERE id=?').get(id) as { confidence: number })
        .confidence,
    ).toBeCloseTo(0.75);
    recordOutcome(id, false);
    // (2+1)/(3+2) = 0.6
    expect(
      (db.prepare('SELECT confidence FROM core_beliefs WHERE id=?').get(id) as { confidence: number })
        .confidence,
    ).toBeCloseTo(0.6);
  });

  it('TTL decay marks stale and confidence reverts toward 0.5 on read', () => {
    const id = upsertBelief({
      sourceTable: 'x',
      sourceRowId: 1,
      predicate: 'p',
      summary: 's',
      ttlSec: 10,
      evidence: ['msg:1'],
    })!;
    recordOutcome(id, true);
    recordOutcome(id, true); // 0.75
    const now = Math.floor(Date.now() / 1000) + 11;
    const [b] = getActiveBeliefs('p', { now });
    expect(b!.effectiveStatus).toBe('stale');
    expect(b!.decayedConfidence).toBeCloseTo(0.5);
  });
});
