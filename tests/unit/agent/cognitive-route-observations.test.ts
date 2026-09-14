import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  completeCognitiveRouteObservation,
  getCognitiveRouteWindow,
  recordCognitiveRouteDecision,
  recordCognitiveRouteFeedback,
  recordCognitiveRouteFeedbackForTrigger,
} from '../../../src/agent/cognitive-route-observations.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0106_cognitive_route_observations.sql', 'utf8'));
});

describe('durable cognitive route observations', () => {
  it('deduplicates a trigger and keeps the first classification', () => {
    const first = recordCognitiveRouteDecision({
      chatId: -100,
      triggerMessageId: 42,
      route: 'deep',
      score: 4,
      primarySignal: 'open_debt',
      behaviorApplied: true,
      createdAt: 1_700_000_000,
    });
    const retry = recordCognitiveRouteDecision({
      chatId: -100,
      triggerMessageId: 42,
      route: 'fast',
      score: 0,
      createdAt: 1_700_000_001,
    });
    expect(first).toBeTypeOf('number');
    expect(retry).toBe(first);
    expect(db.prepare('SELECT route, behavior_applied FROM cognitive_route_observations WHERE id = ?').get(first)).toEqual({
      route: 'deep',
      behavior_applied: 1,
    });
  });

  it('records one terminal outcome idempotently and aggregates bounded window metrics', () => {
    const sent = recordCognitiveRouteDecision({ chatId: -100, triggerMessageId: 1, route: 'deep', score: 3 });
    const silent = recordCognitiveRouteDecision({ chatId: -100, triggerMessageId: 2, route: 'fast', score: 0 });
    const failed = recordCognitiveRouteDecision({ chatId: -100, triggerMessageId: 3, route: 'deep', score: 5 });
    expect(completeCognitiveRouteObservation({ id: sent!, status: 'sent', latencyMs: 120, toolCalls: 2, replyCount: 1, completedAt: 1_700_000_010 })).toBe(true);
    expect(completeCognitiveRouteObservation({ id: sent!, status: 'failed', latencyMs: 999, completedAt: 1_700_000_011 })).toBe(false);
    expect(completeCognitiveRouteObservation({ id: silent!, status: 'silent', latencyMs: 10, toolCalls: 0, replyCount: 0 })).toBe(true);
    expect(completeCognitiveRouteObservation({ id: failed!, status: 'failed', latencyMs: 300, replyCount: 0 })).toBe(true);
    expect(recordCognitiveRouteFeedback({ id: sent!, outcome: 'positive', signal: 'user_replied' })).toBe(true);
    expect(recordCognitiveRouteFeedback({ id: sent!, outcome: 'negative', signal: 'ignored' })).toBe(false);

    expect(getCognitiveRouteWindow({ chatId: -100, since: 1_700_000_000 })).toEqual([
      expect.objectContaining({
        chatId: -100,
        route: 'deep',
        samples: 2,
        completed: 2,
        sent: 1,
        failed: 1,
        meanLatencyMs: 210,
        meanToolCalls: 2,
        meanReplyCount: 0.5,
        feedbackPositive: 1,
        feedbackRate: 0.5,
        positiveFeedbackRate: 1,
      }),
      expect.objectContaining({ chatId: -100, route: 'fast', samples: 1, silent: 1 }),
    ]);
  });

  it('joins later feedback by the original trigger message', () => {
    const id = recordCognitiveRouteDecision({ chatId: -200, triggerMessageId: 9, route: 'background', score: 2 });
    expect(recordCognitiveRouteFeedbackForTrigger({
      chatId: -200,
      triggerMessageId: 9,
      outcome: 'negative',
      signal: 'ignored_5_msgs',
    })).toBe(true);
    expect(recordCognitiveRouteFeedbackForTrigger({
      chatId: -200,
      triggerMessageId: 9,
      outcome: 'positive',
    })).toBe(false);
    expect(getCognitiveRouteWindow({ chatId: -200 })[0]).toEqual(expect.objectContaining({
      route: 'background',
      feedbackNegative: 1,
      positiveFeedbackRate: 0,
    }));
    expect(id).toBeTypeOf('number');
  });

  it('fails closed for invalid identifiers and absent tables', () => {
    expect(recordCognitiveRouteDecision({ chatId: 0, triggerMessageId: 1, route: 'fast', score: 0 })).toBeUndefined();
    expect(recordCognitiveRouteDecision({ chatId: -100, triggerMessageId: 0, route: 'fast', score: 0 })).toBeUndefined();
    expect(recordCognitiveRouteDecision({ chatId: -100, triggerMessageId: 1, route: 'fast', score: Number.NaN })).toBeUndefined();
    db.close();
    db = new Database(':memory:');
    expect(getCognitiveRouteWindow()).toEqual([]);
    expect(completeCognitiveRouteObservation({ id: 1, status: 'sent' })).toBe(false);
  });
});
