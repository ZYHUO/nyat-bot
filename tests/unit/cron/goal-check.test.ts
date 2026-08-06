import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;
const enqueueMock = vi.fn();
const isAsleepMock = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: (...args: unknown[]) => enqueueMock(...args),
}));
vi.mock('../../../src/tracking/sleep.js', () => ({
  isAsleep: () => isAsleepMock(),
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ GOAL_TRACKER_ENABLED: true }),
}));

const { runGoalCheck } = await import('../../../src/cron/goal-check.js');

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL, origin TEXT NOT NULL, chat_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      check_interval_sec INTEGER DEFAULT 86400,
      last_check_at INTEGER, last_finding TEXT,
      findings_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  enqueueMock.mockReset().mockResolvedValue(undefined);
  isAsleepMock.mockReset().mockResolvedValue(false);
});

describe('runGoalCheck', () => {
  it('dispatches CodeAct task for each due goal with goal marker in contentDirection', async () => {
    const ts = nowSec();
    db.prepare(
      `INSERT INTO goals (topic, origin, chat_id, status, check_interval_sec, last_check_at, created_at, updated_at)
       VALUES (?, 'master', 6251541967, 'active', 3600, ?, ?, ?)`,
    ).run('主人的 Sub2API 项目进展', ts - 7200, ts - 10000, ts - 7200);

    await runGoalCheck();
    expect(enqueueMock).toHaveBeenCalledOnce();
    const task = enqueueMock.mock.calls[0]![0] as { id: string; chatId: number; contentDirection: string };
    expect(task.id).toMatch(/^goal_\d+_/);
    expect(task.chatId).toBe(6251541967);
    expect(task.contentDirection).toContain('[goal:');
    expect(task.contentDirection).toContain('Sub2API');
    expect(task.contentDirection).toContain('endTask');
  });

  it('includes last_finding context when present', async () => {
    const ts = nowSec();
    db.prepare(
      `INSERT INTO goals (topic, origin, chat_id, status, check_interval_sec, last_check_at, last_finding, created_at, updated_at)
       VALUES (?, 'self', 1, 'active', 60, ?, '上次发现 v2 发布了', ?, ?)`,
    ).run('某个项目的版本更新', ts - 120, ts - 200, ts - 120);

    await runGoalCheck();
    const task = enqueueMock.mock.calls[0]![0] as { contentDirection: string };
    expect(task.contentDirection).toContain('上次发现');
  });

  it('does nothing when asleep', async () => {
    isAsleepMock.mockResolvedValue(true);
    db.prepare(
      `INSERT INTO goals (topic, origin, status, created_at, updated_at) VALUES ('topic here', 'self', 'active', 1, 1)`,
    ).run();
    await runGoalCheck();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does nothing when no due goals', async () => {
    const ts = nowSec();
    db.prepare(
      `INSERT INTO goals (topic, origin, status, check_interval_sec, last_check_at, created_at, updated_at)
       VALUES ('not due yet', 'self', 'active', 86400, ?, ?, ?)`,
    ).run(ts, ts, ts);
    await runGoalCheck();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('skips stale/achieved goals', async () => {
    db.prepare(
      `INSERT INTO goals (topic, origin, status, created_at, updated_at) VALUES ('stale one', 'self', 'stale', 1, 1)`,
    ).run();
    await runGoalCheck();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
