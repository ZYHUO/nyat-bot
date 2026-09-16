import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => db,
}));

const { createGoal, listDueGoals, recordCheck, setGoalStatus, listGoals, GOAL_STALE_AFTER_SEC, GOAL_LONG_TERM_STALE_AFTER_SEC, markSilentChange, markGoalAchieved, recordUnverifiedCompletion } = await import(
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
      long_term INTEGER DEFAULT 0,
      silent_change_detected INTEGER DEFAULT 0,
      check_count INTEGER DEFAULT 0,
      verified_achievements INTEGER NOT NULL DEFAULT 0,
      unverified_completions INTEGER NOT NULL DEFAULT 0,
      last_evidence TEXT NOT NULL DEFAULT 'unverified',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_goals_status_due ON goals(status, last_check_at);
  `);
});

describe('goal evidence gate', () => {
  it('rejects achieved without verified evidence', () => {
    const id = createGoal({ topic: 'evidence gate probe', origin: 'test' }, 50)!;
    expect(() => markGoalAchieved(id, 'unverified')).toThrow('needs verified evidence');
    expect(listGoals().find((g) => g.id === id)!.status).toBe('active');
  });

  it('records verified achievement with evidence label', () => {
    const id = createGoal({ topic: 'evidence gate pass', origin: 'test' }, 50)!;
    markGoalAchieved(id, 'verified', 'result.json:sum=55');
    const row = listGoals().find((g) => g.id === id)!;
    expect(row.status).toBe('achieved');
    expect(row.verified_achievements).toBe(1);
  });

  it('keeps unverified completion open and counted', () => {
    const id = createGoal({ topic: 'evidence gate open', origin: 'test' }, 50)!;
    recordUnverifiedCompletion(id, 'model said done');
    const row = listGoals().find((g) => g.id === id)!;
    expect(row.status).toBe('active');
    expect(row.unverified_completions).toBe(1);
  });
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
      expect(createGoal({ topic: ['显卡行情', '足球赛果', '明天天气', '新番更新'][i]!, origin: 'self' })).not.toBeNull();
    }
    expect(createGoal({ topic: '白菜价格走势', origin: 'self' }, 5)).toBeNull();
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

  it('AGI L5 P3: long_term goal survives past normal stale window (30d instead of 7d)', () => {
    const id = createGoal({ topic: '长期关注的目标', origin: 'master', longTerm: true })!;
    // 10 天无发现:普通目标已 stale,long_term 仍 active(窗口 30 天)
    db.prepare(`UPDATE goals SET created_at = ? WHERE id = ?`).run(nowSec() - GOAL_STALE_AFTER_SEC - 10, id);
    recordCheck(id, null);
    const g = listGoals()[0]!;
    expect(g.status).toBe('active');
    // 31 天无发现:long_term 也 stale
    db.prepare(`UPDATE goals SET created_at = ? WHERE id = ?`).run(nowSec() - GOAL_LONG_TERM_STALE_AFTER_SEC - 10, id);
    recordCheck(id, null);
    expect(listGoals()[0]!.status).toBe('stale');
  });

  it('AGI L5 P3: check_count increments and markSilentChange sets flag', () => {
    const id = createGoal({ topic: '追踪话题', origin: 'master' })!;
    recordCheck(id, '有发现');
    recordCheck(id, null);
    const g = listGoals()[0]!;
    expect(g.check_count).toBe(2);
    expect(g.silent_change_detected).toBe(0);
    markSilentChange(id);
    expect(listGoals()[0]!.silent_change_detected).toBe(1);
  });
});

describe('listGoals / setGoalStatus', () => {
  it('filters by status and updates status', () => {
    const a = createGoal({ topic: '比特币行情追踪', origin: 'self' })!;
    createGoal({ topic: '显卡降价消息', origin: 'self' });
    setGoalStatus(a, 'dropped');
    expect(listGoals('active').length).toBe(1);
    expect(listGoals('dropped').length).toBe(1);
    expect(listGoals().length).toBe(2);
  });
});

describe('same-task dedup（2026-08-22 goal 8/9 重复事故）', () => {
  it('同一 taskId 的 backstop 和 episode 蒸馏只立一个 goal', () => {
    const first = createGoal({ topic: '明天把毛毛团成球丢掉', origin: 'promise-backstop:task-abc123' });
    expect(first).not.toBeNull();
    // 同 taskId、措辞不同 —— 以前会绕过 topic 去重再立一个
    const second = createGoal({ topic: '明天按承诺清理猫毛并告知主人', origin: 'episode:task-abc123' });
    expect(second).toBeNull();
  });

  it('不同 taskId 不互相挡', () => {
    const a = createGoal({ topic: '明天带伞提醒', origin: 'promise-backstop:task-111aaa' });
    const b = createGoal({ topic: '新番更新追更', origin: 'promise-backstop:task-222bbb' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('无 taskId 的 origin（master/self）不受影响', () => {
    const a = createGoal({ topic: 'master 指派的事', origin: 'master' });
    const b = createGoal({ topic: '另一个 self 立的', origin: 'self' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

describe('topic 同主题去重（2026-08-22 自我增殖事故）', () => {
  it('措辞略异的同主题 goal 被拒（子串）', () => {
    createGoal({ topic: 'DeepSeek API 定价后续变化', origin: 'self' });
    expect(createGoal({ topic: 'DeepSeek API 定价后续变化（峰谷计费规则、新模型发布）', origin: 'self' })).toBeNull();
  });

  it('套话前缀不同但主题相同的被拒（bigram 重叠）', () => {
    createGoal({ topic: '持续关注 AI 模型新版本定价变动 xAI OpenAI Anthropic', origin: 'self' });
    expect(createGoal({ topic: '兑现承诺: AI 模型新版本定价变动 xAI OpenAI Anthropic 阶跃星辰', origin: 'self' })).toBeNull();
  });

  it('真正不同的主题不受影响', () => {
    createGoal({ topic: 'DeepSeek API 定价后续变化', origin: 'self' });
    expect(createGoal({ topic: '明天提醒主人带伞', origin: 'self' })).not.toBeNull();
  });
});
