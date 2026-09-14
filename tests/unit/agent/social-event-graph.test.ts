import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { buildSocialGraph, evaluateSocialRepairs, listSocialInteractions, recordSocialInteraction, summarizeSocialRepairs } from '../../../src/agent/social-event-graph.js';

function apply(name: string): void {
  db.exec(readFileSync(`migrations/${name}`, 'utf8'));
}

beforeEach(() => {
  db = new Database(':memory:');
  apply('0089_cognitive_events.sql');
  apply('0102_social_event_graph.sql');
});

afterEach(() => db.close());

describe('replayable social event graph', () => {
  it('records metadata-only interactions and deduplicates retries', () => {
    const input = {
      chatId: -100,
      fromUid: 11,
      toUid: 22,
      kind: 'reply' as const,
      messageId: 501,
      occurredAt: 1_700_000_000,
      correlationId: 'telegram:-100:social:501',
    };
    const first = recordSocialInteraction(input);
    const retry = recordSocialInteraction(input);

    expect(first?.inserted).toBe(true);
    expect(retry).toEqual({ inserted: false, eventId: first?.eventId });
    expect(listSocialInteractions({ chatId: -100 })).toEqual([expect.objectContaining({
      eventId: first?.eventId,
      fromUid: 11,
      toUid: 22,
      kind: 'reply',
      messageId: 501,
      occurredAt: 1_700_000_000,
      source: 'telegram',
    })]);
    const stored = db.prepare('SELECT fact_json FROM cognitive_events WHERE id = ?').get(first?.eventId) as { fact_json: string };
    expect(stored.fact_json).not.toContain('message text');
  });

  it('builds directed, decayed edges with exact user and as-of filters', () => {
    recordSocialInteraction({ chatId: -100, fromUid: 1, toUid: 2, kind: 'reply', messageId: 1, occurredAt: 100 });
    recordSocialInteraction({ chatId: -100, fromUid: 1, toUid: 2, kind: 'reply', messageId: 2, occurredAt: 200 });
    recordSocialInteraction({ chatId: -100, fromUid: 2, toUid: 1, kind: 'mention', messageId: 3, occurredAt: 200 });
    recordSocialInteraction({ chatId: -100, fromUid: 3, toUid: 4, kind: 'support', messageId: 4, occurredAt: 200 });

    const graph = buildSocialGraph({ chatId: -100, nowSec: 200, maxEdges: 10 });
    expect(graph.interactionCount).toBe(4);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]).toEqual(expect.objectContaining({ fromUid: 1, toUid: 2, interactionCount: 2, kinds: ['reply'] }));
    expect(graph.edges[0]!.weight).toBeGreaterThan(1.9);
    expect(graph.edges[0]!.weight).toBeLessThanOrEqual(2);

    const userGraph = buildSocialGraph({ chatId: -100, userId: 1, nowSec: 200 });
    expect(userGraph.edges.map((edge) => `${edge.fromUid}->${edge.toUid}`)).toEqual(['1->2', '2->1']);

    const anchor = appendCognitiveEvent({
      type: 'world_change',
      source: 'telegram',
      scope: { visibility: 'chat', chatId: -100 },
      occurredAt: 150,
      correlationId: 'telegram:-100:anchor',
      fact: { marker: 'as-of' },
    });
    expect(anchor).toBeTruthy();
    expect(listSocialInteractions({ chatId: -100, asOfEventId: anchor!.event.id }).map((event) => event.messageId)).toEqual([1]);
    expect(buildSocialGraph({ chatId: -100, asOfEventId: anchor!.event.id, maxEdges: 10 }).interactionCount).toBe(1);
  });

  it('rejects invalid writes and foreign as-of anchors', () => {
    expect(recordSocialInteraction({ chatId: 0, fromUid: 1, toUid: 2, kind: 'reply' })).toBeNull();
    expect(recordSocialInteraction({ chatId: -100, fromUid: 1, toUid: 1, kind: 'reply' })).toBeNull();
    expect(recordSocialInteraction({ chatId: -100, fromUid: 1, toUid: 2, kind: 'reply', occurredAt: 0 })).toBeNull();
    expect(recordSocialInteraction({ chatId: -100, fromUid: 1, toUid: 2, kind: 'reply', messageId: Number.NaN })).toBeNull();
    expect(buildSocialGraph({ chatId: -100, limit: Number.NaN, maxEdges: Number.NaN })).toMatchObject({ interactionCount: 0, edges: [] });
    const foreign = appendCognitiveEvent({
      type: 'world_change',
      source: 'telegram',
      scope: { visibility: 'chat', chatId: -200 },
      correlationId: 'foreign-anchor',
      fact: {},
    });
    expect(listSocialInteractions({ chatId: -100, asOfEventId: foreign!.event.id })).toEqual([]);
  });

  it('fails closed when the event migration is absent', () => {
    db.close();
    db = new Database(':memory:');
    expect(recordSocialInteraction({ chatId: -100, fromUid: 1, toUid: 2, kind: 'reply' })).toBeNull();
    expect(listSocialInteractions({ chatId: -100 })).toEqual([]);
  });

  it('evaluates conflict to repair and later follow-up without mutating the graph', () => {
    recordSocialInteraction({ chatId: -100, fromUid: 42, toUid: 9001, kind: 'conflict', messageId: 10, occurredAt: 100 });
    recordSocialInteraction({ chatId: -100, fromUid: 42, toUid: 9001, kind: 'repair', messageId: 11, occurredAt: 120 });
    recordSocialInteraction({ chatId: -100, fromUid: 42, toUid: 9001, kind: 'support', messageId: 12, occurredAt: 150 });
    recordSocialInteraction({ chatId: -100, fromUid: 7, toUid: 8, kind: 'conflict', messageId: 13, occurredAt: 200 });
    recordSocialInteraction({ chatId: -100, fromUid: 7, toUid: 8, kind: 'repair', messageId: 14, occurredAt: 220 });

    expect(evaluateSocialRepairs({ chatId: -100, windowSec: 1000 })).toEqual([
      expect.objectContaining({
        actorUid: 7,
        targetUid: 8,
        conflictEventId: expect.any(String),
        repairEventId: expect.any(String),
        followupEventId: null,
        repaired: false,
        repairLatencySec: 20,
      }),
      expect.objectContaining({
        actorUid: 42,
        targetUid: 9001,
        followupKind: 'support',
        repaired: true,
        repairLatencySec: 20,
      }),
    ]);
    expect(summarizeSocialRepairs({ chatId: -100, windowSec: 1000 })).toEqual({
      samples: 2,
      repaired: 1,
      repairRate: 0.5,
      meanLatencySec: 20,
    });
  });
});
