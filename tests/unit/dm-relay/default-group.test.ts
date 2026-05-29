import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { setDefaultGroup, getDefaultGroup, clearDefaultGroup } = await import(
  '../../../src/tracking/user-profile.js'
);

function initSchema(db: Database.Database): void {
  for (const m of [
    'migrations/0007_user_preferences.sql',
    'migrations/0008_mute_dedup.sql',
    'migrations/0023_dm_cleanup.sql',
  ]) {
    db.exec(readFileSync(resolve(process.cwd(), m), 'utf-8'));
  }
}

describe('default-group preference', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    // 0023 references fate_history + anonymous_notes for its other indexes — create stubs
    testDb.exec(`CREATE TABLE IF NOT EXISTS fate_history (id INTEGER PRIMARY KEY, user_id TEXT, drawn_at DATE);`);
    testDb.exec(`CREATE TABLE IF NOT EXISTS anonymous_notes (id INTEGER PRIMARY KEY, published_at INTEGER, status TEXT);`);
    initSchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns null when no default set', () => {
    expect(getDefaultGroup(42)).toBeNull();
  });

  it('sets and reads a default group', () => {
    setDefaultGroup(42, -100123);
    expect(getDefaultGroup(42)).toBe(-100123);
  });

  it('upserts (one default per user, not duplicated)', () => {
    setDefaultGroup(42, -100123);
    setDefaultGroup(42, -200456);
    expect(getDefaultGroup(42)).toBe(-200456);
    const cnt = (testDb.prepare(
      "SELECT COUNT(*) c FROM user_preferences WHERE uid = 42 AND pref_key = 'default_group'",
    ).get() as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('keeps per-user isolation', () => {
    setDefaultGroup(1, -111);
    setDefaultGroup(2, -222);
    expect(getDefaultGroup(1)).toBe(-111);
    expect(getDefaultGroup(2)).toBe(-222);
  });

  it('clears a default group', () => {
    setDefaultGroup(42, -100123);
    clearDefaultGroup(42);
    expect(getDefaultGroup(42)).toBeNull();
  });
});
