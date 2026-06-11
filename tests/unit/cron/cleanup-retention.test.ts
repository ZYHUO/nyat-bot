import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// 审计 #40:append-only 日志表 retention。各表用生产真实的列类型:
// unix 秒(reply_outcomes.ts / relay_log.created_at / reputation_log.created_at /
// reply_reflections.updated_at)、DATETIME 文本(fate_history.created_at)、
// DATE 文本(daily_stats.date)。

let testDb: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { pruneLogRetention } = await import('../../../src/cron/cleanup.js');

const NOW_SEC = Math.floor(Date.now() / 1000);
const daysAgoSec = (d: number): number => NOW_SEC - d * 86400;
const daysAgoDatetime = (d: number): string =>
  new Date(Date.now() - d * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
const daysAgoDate = (d: number): string =>
  new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

function init(db: Database.Database): void {
  db.exec(`
    CREATE TABLE reply_outcomes (id INTEGER PRIMARY KEY, ts INTEGER);
    CREATE TABLE relay_log (id INTEGER PRIMARY KEY, created_at INTEGER);
    CREATE TABLE reputation_log (id INTEGER PRIMARY KEY, created_at INTEGER);
    CREATE TABLE fate_history (id INTEGER PRIMARY KEY, created_at DATETIME);
    CREATE TABLE daily_stats (chat_id INTEGER, date TEXT, total_messages INTEGER);
    CREATE TABLE reply_reflections (chat_id INTEGER PRIMARY KEY, updated_at INTEGER);
  `);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  init(testDb);
});
afterEach(() => testDb.close());

const count = (table: string): number =>
  (testDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe('pruneLogRetention (#40)', () => {
  it('prunes unix-second tables at the 90d window', () => {
    for (const t of ['reply_outcomes', 'relay_log', 'reputation_log']) {
      const col = t === 'reply_outcomes' ? 'ts' : 'created_at';
      testDb.prepare(`INSERT INTO ${t} (${col}) VALUES (?)`).run(daysAgoSec(91)); // 过期
      testDb.prepare(`INSERT INTO ${t} (${col}) VALUES (?)`).run(daysAgoSec(89)); // 保留
    }

    pruneLogRetention();

    for (const t of ['reply_outcomes', 'relay_log', 'reputation_log']) {
      expect(count(t), t).toBe(1);
    }
  });

  it('prunes fate_history via DATETIME-text comparison', () => {
    testDb.prepare('INSERT INTO fate_history (created_at) VALUES (?)').run(daysAgoDatetime(91));
    testDb.prepare('INSERT INTO fate_history (created_at) VALUES (?)').run(daysAgoDatetime(1));

    pruneLogRetention();
    expect(count('fate_history')).toBe(1);
  });

  it('prunes daily_stats and reply_reflections at the 180d window', () => {
    testDb.prepare('INSERT INTO daily_stats (chat_id, date, total_messages) VALUES (1, ?, 1)').run(daysAgoDate(181));
    testDb.prepare('INSERT INTO daily_stats (chat_id, date, total_messages) VALUES (1, ?, 1)').run(daysAgoDate(179));
    testDb.prepare('INSERT INTO reply_reflections (chat_id, updated_at) VALUES (1, ?)').run(daysAgoSec(181));
    testDb.prepare('INSERT INTO reply_reflections (chat_id, updated_at) VALUES (2, ?)').run(daysAgoSec(10));

    pruneLogRetention();
    expect(count('daily_stats')).toBe(1);
    expect(count('reply_reflections')).toBe(1);
  });

  it('a missing table does not abort the rest (per-table try/catch)', () => {
    testDb.exec('DROP TABLE reply_outcomes');
    testDb.prepare('INSERT INTO relay_log (created_at) VALUES (?)').run(daysAgoSec(91));

    expect(() => pruneLogRetention()).not.toThrow();
    expect(count('relay_log')).toBe(0); // 后续表照常清
  });

  it('fresh rows survive untouched across all tables', () => {
    testDb.prepare('INSERT INTO reply_outcomes (ts) VALUES (?)').run(daysAgoSec(1));
    testDb.prepare('INSERT INTO fate_history (created_at) VALUES (?)').run(daysAgoDatetime(1));
    testDb.prepare('INSERT INTO daily_stats (chat_id, date, total_messages) VALUES (1, ?, 1)').run(daysAgoDate(1));

    pruneLogRetention();
    expect(count('reply_outcomes')).toBe(1);
    expect(count('fate_history')).toBe(1);
    expect(count('daily_stats')).toBe(1);
  });
});
