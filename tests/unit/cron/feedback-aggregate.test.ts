/**
 * Feedback Aggregate —— 自我认知的活水输入。
 *
 * 这条测试锁的是 2026-09-21 发现的真问题：这个 cron 只读 `feedback_events`
 * （一共 4 行），而真正有量的 `reply_outcomes`（12,752 行）从来没被读过。
 * 结果 self_model_notes 最后一条停在 09-11，之后十天什么都没长出来——
 * 而 getActiveSelfNotes 会把最新 5 条注入 prompt，也就是说模型已经有十天
 * 没看到过关于自己的新事实了。
 *
 * 锁四件事：
 *   ① 高忽略率 → 写"我说的话大部分没人接"，且带实测数字当 evidence
 *   ② 同一条认知 6 小时内不重复写（saveSelfNotes 是裸 INSERT，没有唯一约束）
 *   ③ 样本太少（<20）→ 不写，宁可不判断
 *   ④ 文案是事实不是指令（不出现"你必须/应该少说话"这种裁决语气）
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runFeedbackAggregate } = await import('../../../src/cron/feedback-aggregate.js');
const { getActiveSelfNotes } = await import('../../../src/tracking/self-model.js');

const now = (): number => Math.floor(Date.now() / 1000);

function seedOutcomes(spec: { ignored: number; replied: number; mentioned: number; pos?: number; neg?: number }): void {
  const ins = db.prepare(
    `INSERT INTO reply_outcomes (chat_id, ts, trigger_text, reply_text, outcome, signal)
     VALUES (?, ?, '触发', '回复', ?, ?)`,
  );
  const push = (n: number, signal: string, outcome: string): void => {
    for (let i = 0; i < n; i++) ins.run(-100, now() - 60, outcome, signal);
  };
  push(spec.ignored, 'ignored_5_msgs', 'negative');
  push(spec.replied, 'user_replied', 'positive');
  push(spec.mentioned, 'user_mentioned_bot', 'positive');
  push(spec.pos ?? 0, 'explicit_positive', 'positive');
  push(spec.neg ?? 0, 'explicit_negative', 'negative');
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const f of ['0002_phase3.sql', '0024_reply_quality.sql']) {
    try {
      db.exec(readFileSync(`migrations/${f}`, 'utf8'));
    } catch {
      /* 某些库里表在别的迁移里；缺表由下面的 ensure 兜住 */
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reply_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    trigger_text TEXT, reply_text TEXT, outcome TEXT NOT NULL, signal TEXT NOT NULL, action TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS self_model_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, evidence TEXT,
    created_at INTEGER NOT NULL)`);
});

describe('feedback aggregate · 回复结果自画像', () => {
  it('① 高忽略率 → 写"我说的话大部分没人接"，带实测数字', async () => {
    seedOutcomes({ ignored: 80, replied: 10, mentioned: 5 });
    await runFeedbackAggregate();
    const notes = getActiveSelfNotes(5);
    expect(notes.length).toBeGreaterThan(0);
    const top = notes[0]!.note;
    expect(top).toContain('我说的话大部分没人接');
    expect(top).toContain('95');   // 80/95 条没人接
    expect(notes[0]!.evidence).toContain('reply_outcomes');
    expect(notes[0]!.evidence).toContain('total=95');
  });

  it('② 同一条认知 6 小时内不重复写', async () => {
    seedOutcomes({ ignored: 80, replied: 10, mentioned: 5 });
    await runFeedbackAggregate();
    const after1 = db.prepare('SELECT COUNT(*) n FROM self_model_notes').get() as { n: number };
    await runFeedbackAggregate();
    await runFeedbackAggregate();
    const after3 = db.prepare('SELECT COUNT(*) n FROM self_model_notes').get() as { n: number };
    expect(after3.n).toBe(after1.n);
  });

  it('②b 超过 6 小时可以再写一次（认知要能更新，不能永久闭嘴）', async () => {
    seedOutcomes({ ignored: 80, replied: 10, mentioned: 5 });
    await runFeedbackAggregate();
    // 把已有笔记推到 7 小时前
    db.prepare('UPDATE self_model_notes SET created_at = ?').run(now() - 7 * 3600);
    await runFeedbackAggregate();
    const n = db.prepare('SELECT COUNT(*) n FROM self_model_notes').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('③ 样本太少（<20）→ 不写', async () => {
    seedOutcomes({ ignored: 9, replied: 2, mentioned: 1 }); // total=12
    await runFeedbackAggregate();
    const n = db.prepare('SELECT COUNT(*) n FROM self_model_notes').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('③b 完全没有回复结果 → 不写，也不炸', async () => {
    await runFeedbackAggregate();
    const n = db.prepare('SELECT COUNT(*) n FROM self_model_notes').get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('④ 文案是事实不是指令', async () => {
    seedOutcomes({ ignored: 80, replied: 10, mentioned: 5 });
    await runFeedbackAggregate();
    const note = db.prepare('SELECT note FROM self_model_notes LIMIT 1').get() as { note: string };
    // 可以有建议性的收尾，但不能是指令式的裁决措辞
    expect(note.note).not.toMatch(/你必须|你应该|不准|禁止|一定要/);
    expect(note.note).toMatch(/没人接|有人回/);
  });

  it('⑤ 有人接的时候写的是另一条（不是永远只报坏消息）', async () => {
    seedOutcomes({ ignored: 20, replied: 40, mentioned: 30, pos: 10 });
    await runFeedbackAggregate();
    const rows = db.prepare('SELECT note FROM self_model_notes').all() as Array<{ note: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.note).toContain('我说的话有人接');
  });
});
