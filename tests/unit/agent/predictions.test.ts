import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  recordPrediction,
  resolvePrediction,
  recentResolvedPredictions,
  summarizePredictionCalibration,
  summarizePredictionCalibrationByDimension,
  listPredictionModelRevisions,
} = await import('../../../src/agent/predictions.js');

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

  it('uses a signed prediction scale after the scope migration', () => {
    db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    recordPrediction({ chatId: -100, messageId: 88, predictedSentiment: 0.5, sourceEventId: 'delivery-1' });
    resolvePrediction({ chatId: -100, messageId: 88, actualSentiment: -0.6, feedbackKind: 'reaction', outcomeEventId: 'feedback-1' });
    const row = db.prepare('SELECT predicted_sentiment, predicted_signed, prediction_scale, outcome_event_id, scope_key FROM bot_predictions WHERE message_id = 88').get() as {
      predicted_sentiment: number;
      predicted_signed: number;
      prediction_scale: string;
      outcome_event_id: string;
      scope_key: string;
    };
    expect(row.predicted_sentiment).toBeCloseTo(0.5);
    expect(row.predicted_signed).toBeCloseTo(0);
    expect(row.prediction_scale).toBe('probability');
    expect(row.outcome_event_id).toBe('feedback-1');
    expect(row.scope_key).toBe('chat:-100');
    expect(recentResolvedPredictions(10)[0]?.predictionError).toBeCloseTo(-0.6);
    expect(summarizePredictionCalibration(-100)).toMatchObject({ samples: 1, meanError: -0.6, meanAbsoluteError: 0.6 });
  });

  it('stores dimensions and groups calibration by user and action', () => {
    db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    db.exec(readFileSync('migrations/0100_prediction_dimensions.sql', 'utf8'));
    recordPrediction({ chatId: -100, messageId: 101, userId: 7, actionType: 'speak', predictedSentiment: 0.5 });
    recordPrediction({ chatId: -100, messageId: 102, userId: 7, actionType: 'speak', predictedSentiment: 0.5 });
    recordPrediction({ chatId: -100, messageId: 103, userId: 8, actionType: 'speak', predictedSentiment: 0.5 });
    resolvePrediction({ chatId: -100, messageId: 101, actualSentiment: 1, feedbackKind: 'reaction' });
    resolvePrediction({ chatId: -100, messageId: 102, actualSentiment: 0, feedbackKind: 'reaction' });
    resolvePrediction({ chatId: -100, messageId: 103, actualSentiment: -1, feedbackKind: 'reaction' });
    expect(recentResolvedPredictions(10)[0]).toEqual(expect.objectContaining({ userId: 8, actionType: 'speak' }));
    expect(summarizePredictionCalibrationByDimension({ chatId: -100, userId: 7, actionType: 'speak' })).toEqual([
      expect.objectContaining({
        chatId: -100,
        userId: 7,
        actionType: 'speak',
        calibration: expect.objectContaining({ samples: 2, meanError: 0.5 }),
      }),
    ]);
  });

  it('records bounded model revisions after minimum host-observed dimension evidence', () => {
    db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
    db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
    db.exec(readFileSync('migrations/0100_prediction_dimensions.sql', 'utf8'));
    db.exec(readFileSync('migrations/0101_prediction_model_revisions.sql', 'utf8'));

    for (const messageId of [201, 202, 203, 204]) {
      recordPrediction({ chatId: -100, messageId, userId: 7, actionType: 'SPEAK', predictedSentiment: 0.5 });
    }
    resolvePrediction({ chatId: -100, messageId: 201, actualSentiment: 1, feedbackKind: 'reaction', outcomeEventId: 'feedback-201' });
    resolvePrediction({ chatId: -100, messageId: 202, actualSentiment: 1, feedbackKind: 'reaction', outcomeEventId: 'feedback-202' });
    resolvePrediction({ chatId: -100, messageId: 203, actualSentiment: 0, feedbackKind: 'reaction', outcomeEventId: 'feedback-203' });

    let revisions = listPredictionModelRevisions({ chatId: -100, userId: 7, actionType: 'speak' });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toEqual(expect.objectContaining({
      chatId: -100,
      userId: 7,
      actionType: 'speak',
      sampleCount: 3,
      meanError: expect.closeTo(2 / 3, 8),
      previousBias: 0,
      newBias: expect.closeTo(1 / 6, 8),
      sourcePredictionId: 3,
      outcomeEventId: 'feedback-203',
    }));

    resolvePrediction({ chatId: -100, messageId: 204, actualSentiment: -1, feedbackKind: 'reaction', outcomeEventId: 'feedback-204' });
    revisions = listPredictionModelRevisions({ chatId: -100, userId: 7, actionType: 'speak' });
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(expect.objectContaining({
      sampleCount: 4,
      meanError: expect.closeTo(1 / 4, 8),
      previousBias: expect.closeTo(1 / 6, 8),
      newBias: expect.closeTo(3 / 16, 8),
      sourcePredictionId: 4,
      outcomeEventId: 'feedback-204',
    }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM prediction_model_revisions').get()).toEqual({ count: 2 });
  });
});
