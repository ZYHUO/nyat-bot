import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { runDebtSweep } = await import('../../../src/cron/debt-sweep.js');
const { createDebt, listOpenDebts } = await import('../../../src/agent/cognitive-debts.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
  db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
});

describe('debt sweep', () => {
  it('expires stale debts and reports due count', async () => {
    const id = createDebt({ chatId: -100, kind: 'uncertainty', statement: '临时传闻待核', ttlSec: 60 });
    expect(id).not.toBeNull();
    const ts = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE cognitive_debts SET expires_at = ? WHERE id = ?`).run(ts - 120, id);
    const result = await runDebtSweep();
    expect(result.expired).toBe(1);
    expect(listOpenDebts(-100)).toHaveLength(0);
    expect(result.dueCount).toBe(0);
  });

  it('reports due debts that are not yet expired', async () => {
    createDebt({ chatId: -100, kind: 'promise', statement: '答应查更新', nextCheckInSec: 60 });
    const result = await runDebtSweep();
    expect(result.expired).toBe(0);
    expect(result.dueCount).toBe(0); // next_check_at 在未来，不算到期
    db.prepare(`UPDATE cognitive_debts SET next_check_at = 0`).run();
    const after = await runDebtSweep();
    expect(after.dueCount).toBe(1);
  });

  it('summarizes prediction errors without throwing', async () => {
    db.exec(
      `INSERT INTO bot_predictions (chat_id, message_id, predicted_sentiment, actual_sentiment, prediction_error, feedback_kind, created_at, resolved_at)
       VALUES (-100, 1, 0.5, -0.5, -1.0, 'reaction', 1, 2)`,
    );
    const result = await runDebtSweep();
    expect(result.predictionChats).toBe(1);
  });
});
