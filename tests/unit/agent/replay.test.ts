import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { replayCognitiveCorrelation } from '../../../src/agent/replay.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
  db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
});

describe('cognitive replay', () => {
  it('replays in sequence order without mutating by default', async () => {
    const first = appendCognitiveEvent({
      type: 'user_correction', source: 'telegram',
      scope: { visibility: 'chat', chatId: -100 }, correlationId: 'corr-1',
      fact: { reason: '先核实' },
    });
    appendCognitiveEvent({
      type: 'task_observation', source: 'host',
      scope: { visibility: 'task', chatId: -100, taskId: 'task-1' }, correlationId: 'corr-1',
      fact: { kind: 'task_waiting_user' },
    });
    const seen: string[] = [];
    const report = await replayCognitiveCorrelation({
      correlationId: 'corr-1',
      onEvent: (event) => { seen.push(event.id); },
    });
    expect(report.events).toBe(2);
    expect(report.sequences).toEqual([1, 2]);
    expect(report.eventIds).toEqual(seen);
    expect(report.projectionsApplied).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cognitive_debts').get()).toEqual({ n: 0 });
    expect(first?.event.sequence).toBe(1);
  });

  it('can apply the same idempotent projection used by the outbox worker', async () => {
    appendCognitiveEvent({
      type: 'user_correction', source: 'telegram',
      scope: { visibility: 'chat', chatId: -100 }, correlationId: 'corr-2',
      fact: { reason: '需要重查' },
    });
    const report = await replayCognitiveCorrelation({
      correlationId: 'corr-2',
      applyProjections: true,
    });
    expect(report.projectionsApplied).toBe(1);
    expect(report.projectionResults[0]?.debtsCreated).toBe(1);
    const again = await replayCognitiveCorrelation({ correlationId: 'corr-2', applyProjections: true });
    expect(again.projectionResults[0]?.debtsCreated).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM cognitive_debts').get()).toEqual({ n: 1 });
  });
});

