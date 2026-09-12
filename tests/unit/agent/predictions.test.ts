import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { recordPrediction, resolvePrediction, recentResolvedPredictions } = await import('../../../src/agent/predictions.js');

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
});

describe('predictions', () => {
  it('records a prior prediction and resolves it with error', () => {
    recordPrediction({ chatId: -100, taskId: 't1', messageId: 42, source: 'system_prior', predictedSentiment: 0.5 });
    resolvePrediction({ chatId: -100, messageId: 42, actualSentiment: -0.6, feedbackKind: 'reaction' });
    const rows = recentResolvedPredictions(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.predictionError).toBeCloseTo(-1.1);
    expect(rows[0]!.taskId).toBe('t1');
    expect(rows[0]!.feedbackKind).toBe('reaction');
  });

  it('resolves pending predictions newest-first, one per feedback', () => {
    recordPrediction({ chatId: -100, messageId: 7, predictedSentiment: 0.5 });
    recordPrediction({ chatId: -100, messageId: 7, predictedSentiment: 0.5 });
    resolvePrediction({ chatId: -100, messageId: 7, actualSentiment: 0.8, feedbackKind: 'replier_sentiment' });
    resolvePrediction({ chatId: -100, messageId: 7, actualSentiment: 0.9, feedbackKind: 'replier_sentiment' });
    const rows = recentResolvedPredictions(10).sort((a, b) => a.id - b.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.predictionError).toBeCloseTo(0.4);
    expect(rows[1]!.predictionError).toBeCloseTo(0.3);
  });

  it('ignores resolution when no prediction exists', () => {
    resolvePrediction({ chatId: -100, messageId: 999, actualSentiment: 0.8, feedbackKind: 'reaction' });
    expect(recentResolvedPredictions(10)).toHaveLength(0);
  });
});
