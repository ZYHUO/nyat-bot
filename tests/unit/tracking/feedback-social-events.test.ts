import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 9001 }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listSocialInteractions } from '../../../src/agent/social-event-graph.js';
import { recordReaction, recordReplySentiment } from '../../../src/tracking/feedback.js';

function apply(name: string): void {
  db.exec(readFileSync(`migrations/${name}`, 'utf8'));
}

beforeEach(() => {
  db = new Database(':memory:');
  apply('0070_feedback_and_subtasks.sql');
  apply('0088_bot_predictions.sql');
  apply('0089_cognitive_events.sql');
  apply('0102_social_event_graph.sql');
});

describe('feedback social interaction bridge', () => {
  it('records positive and negative reactions as directed support/conflict edges', () => {
    recordReaction({ userId: 42, botMessageId: 7, chatId: -100, emoji: '👍' });
    recordReaction({ userId: 43, botMessageId: 8, chatId: -100, emoji: '👎' });

    expect(listSocialInteractions({ chatId: -100 }).map((event) => ({
      fromUid: event.fromUid,
      toUid: event.toUid,
      kind: event.kind,
      messageId: event.messageId,
    })).sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0))).toEqual([
      { fromUid: 42, toUid: 9001, kind: 'support', messageId: 7 },
      { fromUid: 43, toUid: 9001, kind: 'conflict', messageId: 8 },
    ]);
  });

  it('records corrections as repair and keeps follow-up text out of the event fact', () => {
    recordReplySentiment({ userId: 42, botMessageId: 9, chatId: -100, userText: '不对，这个事实记错了' });

    const [event] = listSocialInteractions({ chatId: -100 });
    expect(event).toEqual(expect.objectContaining({ fromUid: 42, toUid: 9001, kind: 'repair', messageId: 9 }));
    const row = db.prepare("SELECT fact_json FROM cognitive_events WHERE type = 'social_interaction'").get() as { fact_json: string };
    expect(row.fact_json).not.toContain('事实记错');
  });
});
