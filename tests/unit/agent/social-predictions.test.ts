import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  expireSocialPredictions,
  listSocialPredictions,
  recordSocialDeliveryPrediction,
  recordSocialPrediction,
  resolveSocialPredictionsForInteraction,
  socialEngagementProbability,
  summarizeSocialPredictionCalibration,
} from '../../../src/agent/social-predictions.js';
import { recordSocialInteraction } from '../../../src/agent/social-event-graph.js';

function apply(name: string): void {
  db.exec(readFileSync(`migrations/${name}`, 'utf8'));
}

beforeEach(() => {
  db = new Database(':memory:');
  apply('0089_cognitive_events.sql');
  apply('0102_social_event_graph.sql');
  apply('0103_social_predictions.sql');
});

afterEach(() => db.close());

describe('social prediction ledger', () => {
  it('records a bounded delivery expectation and deduplicates retries', () => {
    expect(socialEngagementProbability({ chatId: -100, replyToMessageId: 9, actionType: 'conversation' })).toBe(0.7);
    const first = recordSocialDeliveryPrediction({
      chatId: -100,
      botMessageId: 10,
      targetUserId: 42,
      triggerMessageId: 8,
      replyToMessageId: 9,
      actionType: 'conversation',
      sourceEventId: 'delivery-10',
    });
    const retry = recordSocialDeliveryPrediction({
      chatId: -100,
      botMessageId: 10,
      targetUserId: 42,
      triggerMessageId: 8,
      actionType: 'conversation',
      sourceEventId: 'delivery-10',
    });

    expect(first).toMatchObject({ inserted: true, id: expect.any(Number), eventId: expect.any(String) });
    expect(retry).toMatchObject({ inserted: false, id: first!.id });
    expect(listSocialPredictions({ chatId: -100 })).toEqual([expect.objectContaining({
      id: first!.id,
      targetUserId: 42,
      botMessageId: 10,
      triggerMessageId: 8,
      expectedKind: 'engagement',
      expectedProbability: 0.7,
      actionType: 'conversation',
      resolvedAt: null,
    })]);
    const facts = db.prepare("SELECT fact_json FROM cognitive_events WHERE type = 'social_prediction'").all() as Array<{ fact_json: string }>;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.fact_json).not.toContain('message text');
  });

  it('settles from a matching interaction and records prediction error', () => {
    const prediction = recordSocialPrediction({
      chatId: -100,
      botMessageId: 20,
      targetUserId: 42,
      expectedKind: 'engagement',
      expectedProbability: 0.4,
      actionType: 'final',
    });
    expect(prediction).toBeTruthy();
    const interaction = recordSocialInteraction({
      chatId: -100,
      fromUid: 42,
      toUid: 9001,
      kind: 'reply',
      messageId: 20,
      occurredAt: 1_700_000_010,
    });
    expect(interaction).toBeTruthy();
    expect(resolveSocialPredictionsForInteraction({
      chatId: -100,
      botMessageId: 20,
      actorUserId: 42,
      kind: 'reply',
      eventId: interaction!.eventId,
      occurredAt: 1_700_000_010,
    })).toBe(0);
    const [row] = listSocialPredictions({ chatId: -100 });
    expect(row).toEqual(expect.objectContaining({
      observedKind: 'reply',
      observedScore: 1,
      predictionError: 0.6,
      outcomeEventId: interaction!.eventId,
      resolvedAt: 1_700_000_010,
    }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM cognitive_events WHERE type = 'social_prediction'").get()).toEqual({ count: 2 });
  });

  it('does not let another user settle a targeted expectation and captures mismatch', () => {
    recordSocialPrediction({ chatId: -100, botMessageId: 30, targetUserId: 42, expectedKind: 'support', expectedProbability: 0.8 });
    expect(resolveSocialPredictionsForInteraction({ chatId: -100, botMessageId: 30, actorUserId: 43, kind: 'support' })).toBe(0);
    expect(resolveSocialPredictionsForInteraction({ chatId: -100, botMessageId: 30, actorUserId: 42, kind: 'conflict' })).toBe(1);
    const [row] = listSocialPredictions({ chatId: -100 });
    expect(row).toEqual(expect.objectContaining({ observedKind: 'conflict', observedScore: 0, predictionError: -0.8 }));
  });

  it('settles silence on expiry and aggregates bounded calibration', () => {
    recordSocialPrediction({ chatId: -100, botMessageId: 40, expectedKind: 'engagement', expectedProbability: 0.25, observationWindowSec: 60 });
    recordSocialPrediction({ chatId: -100, botMessageId: 41, expectedKind: 'silence', expectedProbability: 0.75, observationWindowSec: 60 });
    const rows = listSocialPredictions({ chatId: -100 });
    const cutoff = Math.max(...rows.map((row) => row.createdAt + row.observationWindowSec));
    expect(expireSocialPredictions({ chatId: -100, nowSec: cutoff })).toBe(2);
    expect(listSocialPredictions({ chatId: -100, pendingOnly: true })).toEqual([]);
    expect(listSocialPredictions({ chatId: -100 }).map((row) => ({ kind: row.expectedKind, observed: row.observedKind, score: row.observedScore }))).toEqual([
      { kind: 'silence', observed: 'silence', score: 1 },
      { kind: 'engagement', observed: 'silence', score: 0 },
    ]);
    expect(summarizeSocialPredictionCalibration(-100)).toEqual(expect.objectContaining({ samples: 2, accuracy: 0.5 }));
  });

  it('fails closed for invalid or non-group inputs', () => {
    expect(recordSocialPrediction({ chatId: 1, botMessageId: 1, expectedKind: 'engagement', expectedProbability: 0.5 })).toBeNull();
    expect(recordSocialPrediction({ chatId: -100, botMessageId: 0, expectedKind: 'engagement', expectedProbability: 0.5 })).toBeNull();
    expect(recordSocialPrediction({ chatId: -100, botMessageId: 2, expectedKind: 'engagement', expectedProbability: Number.NaN })).toBeNull();
    expect(recordSocialPrediction({ chatId: -100, botMessageId: 3, expectedKind: 'engagement', expectedProbability: 0.5, targetUserId: 0 })).toBeNull();
    db.close();
    db = new Database(':memory:');
    expect(recordSocialPrediction({ chatId: -100, botMessageId: 4, expectedKind: 'engagement', expectedProbability: 0.5 })).toBeNull();
    expect(expireSocialPredictions({ chatId: -100 })).toBe(0);
  });
});
