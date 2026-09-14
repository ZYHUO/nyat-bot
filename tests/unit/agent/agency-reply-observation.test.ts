import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ COGNITIVE_EVENTS_ENABLED: true, COGNITIVE_OUTBOX_ENABLED: true }) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordLegacyReplyObservations } from '../../../src/agent/agency-reply-observation.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
});

describe('legacy Reply Agency observation bridge', () => {
  it('records each real message id and reuses stable idempotency keys', () => {
    const observations = [
      { chatId: -100, triggerMessageId: 11, messageId: 21, text: '第一段', cognitiveAnchorEventId: 'telegram-event-4', segment: 0, judgeAction: 'REPLY' as const, replyPath: 'direct' as const },
      { chatId: -100, triggerMessageId: 11, messageId: 22, text: '第二段', cognitiveAnchorEventId: 'telegram-event-4', segment: 1, judgeAction: 'REPLY' as const, replyPath: 'direct' as const },
    ];

    const first = recordLegacyReplyObservations(observations);
    expect(first).toMatchObject({ recorded: 2, reused: 0, skipped: 0, failed: 0 });
    expect(first.runIds).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_runs').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agency_runs WHERE status = 'succeeded'").get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM execution_receipts').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT causation_id FROM agency_runs ORDER BY id LIMIT 1').get()).toEqual({ causation_id: 'telegram-event-4' });

    const second = recordLegacyReplyObservations(observations);
    expect(second).toMatchObject({ recorded: 0, reused: 2, skipped: 0, failed: 0 });
    expect(second.runIds).toEqual(first.runIds);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_attempts').get()).toEqual({ count: 2 });
  });

  it('skips invalid or empty deliveries without writing runs', () => {
    const result = recordLegacyReplyObservations([
      { chatId: 0, triggerMessageId: 1, messageId: 2, text: 'bad scope' },
      { chatId: -100, triggerMessageId: 0, messageId: 3, text: 'bad trigger' },
      { chatId: -100, triggerMessageId: 1, messageId: 0, text: 'bad message' },
      { chatId: -100, triggerMessageId: 1, messageId: 4, text: '   ' },
    ]);

    expect(result).toMatchObject({ recorded: 0, reused: 0, skipped: 4, failed: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_runs').get()).toEqual({ count: 0 });
  });
});
