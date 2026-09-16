import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));

describe('durable task evidence', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(readFileSync('migrations/0072_task_evidence.sql', 'utf8'));
  });
  afterEach(() => db?.close());

  it('applies the additive migration twice without rewriting historical episodes', () => {
    db.exec('CREATE TABLE episodes (id INTEGER PRIMARY KEY, outcome TEXT); INSERT INTO episodes VALUES (1, \'done\')');
    db.exec(readFileSync('migrations/0072_task_evidence.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM episodes').all()).toEqual([{ id: 1, outcome: 'done' }]);
    expect(db.prepare('SELECT count(*) n FROM task_evidence').get()).toEqual({ n: 0 });
  });

  it('updates one task idempotently after recovery', async () => {
    const { saveTaskEvidence } = await import('../../../src/agent/task-evidence-store.js');
    const record = { taskId: 'recover', chatId: 2, lifecycle: 'done', assessment: 'failed' as const,
      turns: 2, totalCalls: 2, failedCalls: 1, retryCount: 0, reasons: ['check_failed'] };
    saveTaskEvidence(record);
    saveTaskEvidence({ ...record, assessment: 'verified', turns: 3, totalCalls: 3, retryCount: 1, reasons: [] });
    expect(db.prepare('SELECT count(*) n FROM task_evidence').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT assessment, turns FROM task_evidence').get()).toEqual({ assessment: 'verified', turns: 3 });
  });

  it('does not reassign evidence to another chat through an id collision', async () => {
    const { saveTaskEvidence } = await import('../../../src/agent/task-evidence-store.js');
    const record = { taskId: 'collision', chatId: 1, lifecycle: 'done', assessment: 'unverified' as const,
      turns: 1, totalCalls: 1, failedCalls: 0, retryCount: 0, reasons: [] };
    expect(saveTaskEvidence(record)).toBe(true);
    expect(saveTaskEvidence({ ...record, chatId: 2, assessment: 'verified' })).toBe(false);
    expect(db.prepare('SELECT chat_id, assessment FROM task_evidence').get()).toEqual({ chat_id: 1, assessment: 'unverified' });
  });

  it('fails closed for missing schema and malformed telemetry', async () => {
    const { saveTaskEvidence } = await import('../../../src/agent/task-evidence-store.js');
    const record = { taskId: 'bad', chatId: 1, lifecycle: 'done', assessment: 'verified' as const,
      turns: 1, totalCalls: -1, failedCalls: 0, retryCount: 0, reasons: [] };
    expect(saveTaskEvidence(record)).toBe(false);
    db.exec('DROP TABLE task_evidence');
    expect(saveTaskEvidence({ ...record, totalCalls: 1 })).toBe(false);
  });

  it('persists unverified completion separately from lifecycle without claiming success', async () => {
    const { saveTaskEvidence } = await import('../../../src/agent/task-evidence-store.js');
    saveTaskEvidence({ taskId: 'task-a', chatId: 1, lifecycle: 'done', assessment: 'unverified',
      turns: 2, totalCalls: 1, failedCalls: 0, retryCount: 0, reasons: ['No caller contract'] });
    expect(db.prepare('SELECT lifecycle, assessment, turns, total_calls FROM task_evidence WHERE task_id = ?').get('task-a'))
      .toEqual({ lifecycle: 'done', assessment: 'unverified', turns: 2, total_calls: 1 });
  });
});
