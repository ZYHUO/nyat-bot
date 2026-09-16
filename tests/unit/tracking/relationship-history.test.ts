import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
const envValues: Record<string, unknown> = {
  RELATIONSHIP_ENABLED: true,
  RELATIONSHIP_INJECT_THRESHOLD: 20,
};

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

import { getRelationshipAt } from '../../../src/tracking/relationship.js';

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), `migrations/${name}`), 'utf8');
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(migration('0018_self_history_relationship.sql'));
  db.exec(migration('0105_relationship_revisions.sql'));
  envValues.RELATIONSHIP_ENABLED = true;
});

describe('event-anchored relationship revisions', () => {
  it('returns the snapshot visible at the anchor, not the current row', () => {
    const asOf = 1_700_000_100;
    db.prepare(
      `INSERT INTO chat_relationships
       (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(-100, 7, 40, 3, asOf - 10, 'old', asOf - 10);
    db.prepare(
      `UPDATE chat_relationships
          SET affinity = ?, interaction_count = ?, last_interaction_at = ?, last_summary = ?, updated_at = ?
        WHERE chat_id = ? AND uid = ?`,
    ).run(80, 9, asOf + 10, 'new', asOf + 10, -100, 7);

    const state = getRelationshipAt(-100, 7, asOf);
    expect(state).not.toBeNull();
    expect(state?.count).toBe(3);
    expect(state?.lastSummary).toBe('old');
    expect(state?.affinity).toBeCloseTo(40 * Math.pow(1 - 0.002, 10 / 3600), 5);
  });

  it('returns null when no historical row was visible', () => {
    expect(getRelationshipAt(-100, 7, 1_700_000_100)).toBeNull();
  });

  it('does not expose relationship state when the feature is disabled', () => {
    envValues.RELATIONSHIP_ENABLED = false;
    expect(getRelationshipAt(-100, 7, 1_700_000_100)).toEqual({
      affinity: 0,
      count: 0,
      bucket: '一般',
      lastSummary: '',
    });
  });

  it('rejects an invalid event timestamp instead of reading current state', () => {
    expect(getRelationshipAt(-100, 7, 0)).toBeNull();
    expect(getRelationshipAt(-100, 7, Number.NaN)).toBeNull();
  });
});
