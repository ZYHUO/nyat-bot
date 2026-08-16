import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const { createGoal, listDueGoals, recordCheck, setGoalStatus, listGoals, GOAL_STALE_AFTER_SEC } = await import(
  '../../../src/agent/goals.js'
);

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      origin TEXT NOT NULL,
      chat_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      check_interval_sec INTEGER DEFAULT 86400,
      last_check_at INTEGER,
      last_finding TEXT,
      findings_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_goals_status_due ON goals(status, last_check_at);
  `);
});

describe('createGoal', () => {
  it('creates and rejects duplicates', () => {
    const id = createGoal({ topic: '主人的 Sub2API 项目进展', origin: 'master', chatId: 6251541967 });
    expect(id).toBeGreaterThan(0);
    expect(createGoal({ topic: '主人的 Sub2API 项目进展', origin: 'self' })).toBeNull();
  });

  it('rejects too-short topics and respects maxActive cap', () => {
    // 中文 2 字起步可接受;单字/纯标点拒绝。
    expect(createGoal({ topic: '比特币', origin: 'self' })).not.toBeNull();
    expect(createGoal({ topic: 'a', origin: 'self' })).toBeNull();
    expect(createGoal({ topic: '。。。', origin: 'self' })).toBeNull();
    // 已有 1 个 active(比特币),还剩 4 个空位 → 4 个成功,第 5 个拒绝。
    for (let i = 0; i < 4; i++) {
      expect(createGoal({ topic: `goal topic number ${i}`, origin: 'self' })).not.toBeNull();
    }
    expect(createGoal({ topic: 'sixth goal should be rejected', origin: 'self' }, 5)).toBeNull();
  });
});

describe('listDueGoals', () => {
  it('returns never-checked goals first, then overdue ones', () => {
    createGoal({ topic: 'fresh goal never checked', origin: 'self' });
    const old = createGoal({ topic: 'old goal checked long ago', origin: 'self', checkIntervalSec: 3600 })!;
    db.prepare(`UPDATE goals SET last_check_at = ? WHERE id = ?`).run(nowSec() - 7200, old);
    const checkedRecently = createGoal({ topic: 'recently checked goal', origin: 'self', checkIntervalSec: 3600 })!;
    db.prepare(`UPDATE goals SET last_check_at = ? WHERE id = ?`).run(nowSec() - 100, checkedRecently);

    const due = listDueGoals();
    expect(due.length).toBe(2);
    expect(due.some((g) => g.topic.includes('fresh'))).toBe(true);
    expect(due.some((g) => g.topic.includes('old'))).toBe(true);
    expect(due.some((g) => g.topic.includes('recently'))).toBe(false);
  });

  it('skips non-active goals', () => {
    const id = createGoal({ topic: 'achieved goal topic here', origin: 'self' })!;
    setGoalStatus(id, 'achieved');
    expect(listDueGoals().length).toBe(0);
  });
});

describe('recordCheck', () => {
  it('finding bumps findings_count and stores last_finding', () => {
    const id = createGoal({ topic: 'goal with findings', origin: 'self' })!;
    recordCheck(id, '发现主人更新了 nyat-bot 的 judge 路由');
    const g = listGoals()[0]!;
    expect(g.findings_count).toBe(1);
    expect(g.last_finding).toContain('judge 路由');
    expect(g.status).toBe('active');
  });

  it('null finding just marks checked; stale after GOAL_STALE_AFTER_SEC with zero findings', () => {
    const id = createGoal({ topic: 'goal that never finds anything', origin: 'self' })!;
    // 模拟创建时间超过 stale 阈值
    db.prepare(`UPDATE goals SET created_at = ? WHERE id = ?`).run(nowSec() - GOAL_STALE_AFTER_SEC - 10, id);
    recordCheck(id, null);
    const g = listGoals()[0]!;
    expect(g.status).toBe('stale');
    expect(listDueGoals().length).toBe(0);
  });

  it('goals with findings stay active even when old', () => {
    const id = createGoal({ topic: 'old but fruitful goal', origin: 'self' })!;
    db.prepare(`UPDATE goals SET created_at = ? WHERE id = ?`).run(nowSec() - GOAL_STALE_AFTER_SEC - 10, id);
    recordCheck(id, 'something found');
    recordCheck(id, null);
    const g = listGoals()[0]!;
    expect(g.status).toBe('active');
  });
});

describe('listGoals / setGoalStatus', () => {
  it('filters by status and updates status', () => {
    const a = createGoal({ topic: 'goal alpha topic', origin: 'self' })!;
    createGoal({ topic: 'goal beta topic', origin: 'self' });
    setGoalStatus(a, 'dropped');
    expect(listGoals('active').length).toBe(1);
    expect(listGoals('dropped').length).toBe(1);
    expect(listGoals().length).toBe(2);
  });
});
