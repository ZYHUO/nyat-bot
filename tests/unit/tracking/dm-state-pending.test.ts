import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { markDmEver, hasDmEver, listDmEverUids, getPmNudge, upsertPmNudge, markPmDmOpen } =
  await import('../../../src/tracking/dm-state.js');
const { enqueueDmPending, countDmPending, takeDmPending } = await import('../../../src/tracking/dm-pending.js');

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE dm_users (uid INTEGER PRIMARY KEY, first_dm_at INTEGER NOT NULL, last_dm_at INTEGER NOT NULL);
    CREATE TABLE dm_pending_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, intent TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, flushed_at INTEGER);
    CREATE TABLE pm_nudge_state (
      uid INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'none', attempts INTEGER NOT NULL DEFAULT 0,
      last_nudge_at INTEGER, next_nudge_at INTEGER, primary_chat_id INTEGER,
      resentment REAL NOT NULL DEFAULT 0, exhausted_until INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
  `);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  initSchema(testDb);
});

describe('dm-state: dm_ever', () => {
  it('mark + has + list', () => {
    expect(hasDmEver(7)).toBe(false);
    markDmEver(7);
    expect(hasDmEver(7)).toBe(true);
    markDmEver(7); // idempotent
    markDmEver(8);
    expect(listDmEverUids().sort()).toEqual([7, 8]);
  });

  it('listDmEverUids respects maxAge', () => {
    markDmEver(7);
    // back-date uid 7 far past
    testDb.prepare('UPDATE dm_users SET last_dm_at = ? WHERE uid = 7').run(Math.floor(Date.now() / 1000) - 100 * 86400);
    expect(listDmEverUids(90 * 86400)).toEqual([]);
    expect(listDmEverUids(0)).toEqual([7]);
  });
});

describe('dm-state: pm_nudge machine', () => {
  it('default is none/0', () => {
    const s = getPmNudge(99);
    expect(s.state).toBe('none');
    expect(s.attempts).toBe(0);
    expect(s.resentment).toBe(0);
  });

  it('upsert persists patch and merges', () => {
    upsertPmNudge(99, { state: 'nudging', attempts: 2, primaryChatId: -100 });
    const s = getPmNudge(99);
    expect(s.state).toBe('nudging');
    expect(s.attempts).toBe(2);
    expect(s.primaryChatId).toBe(-100);
    upsertPmNudge(99, { attempts: 3 }); // merge, keep state
    expect(getPmNudge(99).state).toBe('nudging');
    expect(getPmNudge(99).attempts).toBe(3);
  });

  it('markPmDmOpen resets attempts/resentment to dm_open', () => {
    upsertPmNudge(99, { state: 'nudging', attempts: 3, resentment: 0.6, exhaustedUntil: 123 });
    markPmDmOpen(99);
    const s = getPmNudge(99);
    expect(s.state).toBe('dm_open');
    expect(s.attempts).toBe(0);
    expect(s.resentment).toBe(0);
    expect(s.exhaustedUntil).toBeNull();
  });
});

describe('dm-pending: 攒话队列', () => {
  it('enqueue + count + gradual take marks flushed', () => {
    enqueueDmPending(7, '想跟TA说梦到TA了', '昨晚');
    enqueueDmPending(7, '想问TA周末干嘛');
    enqueueDmPending(7, '想分享一首歌');
    expect(countDmPending(7)).toBe(3);

    const first = takeDmPending(7, 2); // gradual: 2 at a time
    expect(first).toHaveLength(2);
    expect(first[0]!.intent).toContain('梦到');
    expect(countDmPending(7)).toBe(1); // 2 flushed

    const second = takeDmPending(7, 2);
    expect(second).toHaveLength(1);
    expect(countDmPending(7)).toBe(0);

    expect(takeDmPending(7, 2)).toEqual([]); // empty now
  });

  it('caps at 5 unflushed per user (rolls oldest)', () => {
    for (let i = 0; i < 8; i++) enqueueDmPending(7, `line ${i}`);
    expect(countDmPending(7)).toBe(5);
  });

  it('expired lines are not counted or taken', () => {
    enqueueDmPending(7, 'old line');
    testDb.prepare('UPDATE dm_pending_lines SET expires_at = ? WHERE uid = 7').run(Math.floor(Date.now() / 1000) - 10);
    expect(countDmPending(7)).toBe(0);
    expect(takeDmPending(7)).toEqual([]);
  });

  it('blank intent is ignored', () => {
    enqueueDmPending(7, '   ');
    expect(countDmPending(7)).toBe(0);
  });
});
