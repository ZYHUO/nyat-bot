/**
 * GOAL_LONG_TERM_ENABLED —— 从死旗标变成真开关。
 *
 * 2026-09-21 之前：env.ts 里声明了、.env 里开着，而全仓库没有一处读它。
 * 长期目标的 30 天 stale 窗口是写死的常量，所以"可以关掉长期目标语义"是假的——
 * 设 false 没有任何效果。这是旗标审计里 9 个"开着但没人读"的一个。
 *
 * 这里锁两半：
 *   开着 → long_term 目标按 30 天窗口（原行为，生产不变）
 *   关着 → long_term 目标按普通 7 天窗口 stale（退化，不报错、不消失）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const envValues: Record<string, unknown> = { GOAL_LONG_TERM_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

const { createGoal, recordCheck, listGoals, longTermEnabled, GOAL_STALE_AFTER_SEC, GOAL_LONG_TERM_STALE_AFTER_SEC }
  = await import('../../../src/agent/goals.js');

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshDb(): void {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL, origin TEXT NOT NULL, chat_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      check_interval_sec INTEGER DEFAULT 86400, last_check_at INTEGER,
      last_finding TEXT, findings_count INTEGER DEFAULT 0, long_term INTEGER DEFAULT 0,
      silent_change_detected INTEGER DEFAULT 0, check_count INTEGER DEFAULT 0,
      verified_achievements INTEGER NOT NULL DEFAULT 0,
      unverified_completions INTEGER NOT NULL DEFAULT 0,
      last_evidence TEXT NOT NULL DEFAULT 'unverified',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

function ageGoal(id: number, seconds: number): void {
  db.prepare(`UPDATE goals SET created_at = ? WHERE id = ?`).run(nowSec() - seconds, id);
}

beforeEach(() => {
  freshDb();
  envValues.GOAL_LONG_TERM_ENABLED = true;
});

describe('GOAL_LONG_TERM_ENABLED', () => {
  it('旗标本身读得到（这是它此前的第一个读者）', () => {
    expect(longTermEnabled()).toBe(true);
    envValues.GOAL_LONG_TERM_ENABLED = false;
    expect(longTermEnabled()).toBe(false);
  });

  it('开着：long_term 目标 10 天无发现仍 active（30 天窗口）', () => {
    const id = createGoal({ topic: '长期关注', origin: 'master', longTerm: true })!;
    ageGoal(id, GOAL_STALE_AFTER_SEC + 10);
    recordCheck(id, null);
    expect(listGoals()[0]!.status).toBe('active');
  });

  it('开着：31 天无发现 → stale', () => {
    const id = createGoal({ topic: '长期关注', origin: 'master', longTerm: true })!;
    ageGoal(id, GOAL_LONG_TERM_STALE_AFTER_SEC + 10);
    recordCheck(id, null);
    expect(listGoals()[0]!.status).toBe('stale');
  });

  it('**关着：long_term 目标按普通 7 天窗口 stale**（这条是新增行为）', () => {
    envValues.GOAL_LONG_TERM_ENABLED = false;
    const id = createGoal({ topic: '长期关注', origin: 'master', longTerm: true })!;
    // 10 天：开着时还活着，关着时已经 stale
    ageGoal(id, GOAL_STALE_AFTER_SEC + 10);
    recordCheck(id, null);
    expect(listGoals()[0]!.status).toBe('stale');
  });

  it('关着也不误伤普通目标（7 天窗口本来就是这样）', () => {
    envValues.GOAL_LONG_TERM_ENABLED = false;
    const id = createGoal({ topic: '普通目标', origin: 'self' })!;
    ageGoal(id, GOAL_STALE_AFTER_SEC + 10);
    recordCheck(id, null);
    expect(listGoals()[0]!.status).toBe('stale');
  });

  it('关着时有发现的目标照样 active（窗口只影响零发现的）', () => {
    envValues.GOAL_LONG_TERM_ENABLED = false;
    const id = createGoal({ topic: '长期关注', origin: 'master', longTerm: true })!;
    ageGoal(id, GOAL_LONG_TERM_STALE_AFTER_SEC + 10);
    recordCheck(id, '有新发现');
    recordCheck(id, null);
    expect(listGoals()[0]!.status).toBe('active');
  });
});
