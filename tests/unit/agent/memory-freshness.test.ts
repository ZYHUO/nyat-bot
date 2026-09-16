import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ MEMORY_STALE_AFTER_DAYS: 90 }),
}));

const { markStaleIfExpired, detectChangeInMessage, confirmFresh, staleCaveat, CHANGE_WORDS } = await import(
  '../../../src/agent/memory-freshness.js'
);

function loadMigrations(): void {
  db = new Database(':memory:');
  db.exec(readFileSync(join(__dirname, '../../../migrations/0005_user_profiles.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0044_person_identity.sql'), 'utf8'));
  db.exec(readFileSync(join(__dirname, '../../../migrations/0064_memory_freshness.sql'), 'utf8'));
}

beforeEach(() => {
  loadMigrations();
  const now = 1_800_000_000;
  db.prepare(`INSERT INTO user_profiles (chat_id, uid, username, updated_at, last_confirmed_at) VALUES (-100, 7, 'alice', ?, ?)`).run(now, now - 100 * 86400); // 超期
  db.prepare(`INSERT INTO user_profiles (chat_id, uid, username, updated_at, last_confirmed_at) VALUES (-100, 8, 'bob', ?, ?)`).run(now, now - 10 * 86400); // 新鲜
  db.prepare(`INSERT INTO person_identity (uid, impression, updated_at, last_confirmed_at) VALUES (7, 'alice', ?, ?)`).run(now, now - 100 * 86400);
});

describe('markStaleIfExpired', () => {
  it('marks only expired profiles stale', () => {
    const n = markStaleIfExpired(7, -100, 90, 1_800_000_000);
    expect(n).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT stale FROM user_profiles WHERE uid = 7').get() as { stale: number };
    expect(row.stale).toBe(1);
    const fresh = db.prepare('SELECT stale FROM user_profiles WHERE uid = 8').get() as { stale: number };
    expect(fresh.stale).toBe(0);
  });
});

describe('detectChangeInMessage', () => {
  it('change words mark related old attributes stale', () => {
    const hint = detectChangeInMessage(7, '我换工作了，现在在字节', -100);
    expect(hint).toContain('过时');
    const row = db.prepare('SELECT stale FROM person_identity WHERE uid = 7').get() as { stale: number };
    expect(row.stale).toBe(1);
  });

  it('no change words → no touch', () => {
    const hint = detectChangeInMessage(7, '今天天气不错', -100);
    expect(hint).toBe('');
    const row = db.prepare('SELECT stale FROM person_identity WHERE uid = 7').get() as { stale: number };
    expect(row.stale).toBe(0);
  });

  it('CHANGE_WORDS matches key transitions', () => {
    expect(CHANGE_WORDS.test('我离职了')).toBe(true);
    expect(CHANGE_WORDS.test('我们分手了')).toBe(true);
    expect(CHANGE_WORDS.test('我搬家了')).toBe(true);
    expect(CHANGE_WORDS.test('聊聊股票')).toBe(false);
  });
});

describe('confirmFresh / staleCaveat', () => {
  it('confirmFresh clears stale and updates timestamp', () => {
    db.prepare(`UPDATE user_profiles SET stale = 1 WHERE uid = 7`).run();
    confirmFresh(7, -100);
    const row = db.prepare('SELECT stale, last_confirmed_at FROM user_profiles WHERE uid = 7').get() as { stale: number; last_confirmed_at: number };
    expect(row.stale).toBe(0);
    expect(row.last_confirmed_at).toBeGreaterThan(1_700_000_000);
  });

  it('staleCaveat returns hint when stale exists, empty otherwise', () => {
    expect(staleCaveat(8, -100)).toBe(''); // 新鲜
    db.prepare(`UPDATE user_profiles SET stale = 1 WHERE uid = 8`).run();
    expect(staleCaveat(8, -100)).toContain('过时');
  });
});
