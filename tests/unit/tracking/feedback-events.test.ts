import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordReaction, recordReplySentiment } from '../../../src/tracking/feedback.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0070_feedback_and_subtasks.sql', 'utf8'));
  db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

describe('feedback cognitive events', () => {
  it('records reaction metadata without raw content', async () => {
    recordReaction({ userId: 42, botMessageId: 7, chatId: -100, emoji: '👍' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = db.prepare('SELECT type, chat_id, user_id, fact_json FROM cognitive_events').get() as {
      type: string; chat_id: number; user_id: number; fact_json: string;
    };
    expect(row.type).toBe('user_reaction');
    expect(row.chat_id).toBe(-100);
    expect(row.user_id).toBe(42);
    expect(row.fact_json).not.toContain('raw_text');
  });

  it('maps an explicit correction followup to two idempotent facts', async () => {
    recordReplySentiment({ userId: 42, botMessageId: 8, chatId: -100, userText: '不对，这个事实记错了' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rows = db.prepare('SELECT type FROM cognitive_events ORDER BY sequence').all() as Array<{ type: string }>;
    expect(rows.map((row) => row.type)).toEqual(['user_followup', 'user_correction']);
    // A duplicate Telegram delivery should not create a second fact.
    recordReplySentiment({ userId: 42, botMessageId: 8, chatId: -100, userText: '不对，这个事实记错了' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(db.prepare('SELECT COUNT(*) AS n FROM cognitive_events').get()).toEqual({ n: 2 });
  });
});
