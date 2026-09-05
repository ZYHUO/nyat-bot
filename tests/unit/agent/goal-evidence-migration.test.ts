import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('0073 goal evidence migration', () => {
  it('adds evidence columns and leaves existing goals untouched', () => {
    const db = new Database(':memory:');
    db.exec(readFileSync('migrations/0055_goals.sql', 'utf8'));
    db.exec(`INSERT INTO goals (topic, origin, status, created_at, updated_at)
      VALUES ('watch coupons', 'master', 'active', 1, 1)`);
    db.exec(readFileSync('migrations/0073_goal_evidence.sql', 'utf8'));
    // NOTE: migrations run once each (tracked in _migrations); SQLite has no
    // ADD COLUMN IF NOT EXISTS, matching 0059 convention. Re-apply must fail loudly, not silently.
    expect(() => db.exec(readFileSync('migrations/0073_goal_evidence.sql', 'utf8'))).toThrow(/duplicate column name/);
    const row = db.prepare('SELECT * FROM goals').get() as Record<string, unknown>;
    expect(row['status']).toBe('active');
    expect(row['verified_achievements']).toBe(0);
    expect(row['unverified_completions']).toBe(0);
    expect(row['last_evidence']).toBe('unverified');
  });
});
