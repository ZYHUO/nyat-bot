import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const { getChatFeedbackBias } = await import('../../../src/tracking/feedback.js');

beforeEach(() => {
  db = new Database(':memory:');
  const sql = readFileSync('migrations/0070_feedback_and_subtasks.sql', 'utf8');
  // 只取 feedback_events 建表部分(文件后半是 goal_subtasks, 无依赖也可全跑)
  db.exec(sql);
});

describe('getChatFeedbackBias', () => {
  it('returns 0 with no data (neutral, zero behavior change)', () => {
    expect(getChatFeedbackBias(-100)).toBe(0);
  });

  it('averages sentiment for the chat within window', () => {
    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare(`INSERT INTO feedback_events (kind, user_id, bot_message_id, chat_id, emoji, sentiment, created_at)
      VALUES ('reaction', ?, ?, ?, ?, ?, ?)`);
    ins.run(1, 11, -100, '❤️', 1, now - 100);
    ins.run(2, 12, -100, '👍', 0.5, now - 200);
    ins.run(3, 13, -200, '👎', -1, now - 100); // 别群的不算
    expect(getChatFeedbackBias(-100)).toBeCloseTo(0.75, 2);
    expect(getChatFeedbackBias(-200)).toBeCloseTo(-1, 2);
  });

  it('ignores stale rows outside window', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO feedback_events (kind, user_id, bot_message_id, chat_id, emoji, sentiment, created_at)
      VALUES ('reaction', 1, 11, -100, '❤️', 1, ?)`).run(now - 8 * 86400);
    expect(getChatFeedbackBias(-100)).toBe(0);
  });
});
