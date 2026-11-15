import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  listPublishedActionCircuits,
  publishActionCircuit,
  recordActionCircuitEvaluation,
  recordActionCircuitProposal,
  summarizeCircuitReplay,
} from '../../../src/agent/action-circuits.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

afterEach(() => db.close());

const scope = { visibility: 'chat' as const, chatId: -100 };

function proposal() {
  return recordActionCircuitProposal({
    schema: 'action_circuit.v1',
    name: 'reply-and-follow-up',
    scope,
    trigger: 'a direct question arrives after a wait',
    preconditions: ['the latest message addresses the bot'],
    steps: [
      { action: 'answer', purpose: 'address the latest question', preconditions: ['question is unresolved'] },
      { action: 'wait', purpose: 'leave room for a follow-up', preconditions: [] },
    ],
    acceptanceChecks: ['host receipt exists', 'no duplicate delivery'],
    sourceEventIds: ['social-act-1'],
  });
}

describe('evidence-gated action circuits', () => {
  it('keeps model proposals unverified until receipts and held-out replay pass', () => {
    const candidate = proposal();
    expect(candidate?.inserted).toBe(true);
    expect(recordActionCircuitEvaluation({
      circuitId: candidate!.eventId, scope, requestedStatus: 'verified',
      evaluatedAt: 1_700_000_000,
      hostReceiptIds: [], replaySamples: 2, replaySuccesses: 2, falseSuccesses: 0,
    })?.status).toBe('unverified');
    expect(publishActionCircuit({ circuitId: candidate!.eventId, scope })).toBeNull();

    expect(recordActionCircuitEvaluation({
      circuitId: candidate!.eventId, scope, requestedStatus: 'verified', evaluatedAt: 1_700_000_001,
      hostReceiptIds: ['receipt-1'], replaySamples: 3, replaySuccesses: 3, falseSuccesses: 0,
    })?.status).toBe('verified');
    expect(publishActionCircuit({ circuitId: candidate!.eventId, scope, publishedAt: 1_700_000_002 })?.inserted).toBe(true);
    expect(listPublishedActionCircuits(scope, 10, 1_700_000_003)).toHaveLength(1);
  });

  it('rejects cross-scope evaluation and false-success replay', () => {
    const candidate = proposal();
    expect(candidate).not.toBeNull();
    expect(recordActionCircuitEvaluation({
      circuitId: candidate!.eventId, scope: { visibility: 'chat', chatId: -200 }, requestedStatus: 'verified',
      hostReceiptIds: ['receipt-1'], replaySamples: 3, replaySuccesses: 3, falseSuccesses: 0,
    })).toBeNull();
    expect(recordActionCircuitEvaluation({
      circuitId: candidate!.eventId, scope, requestedStatus: 'verified', evaluatedAt: 1_700_000_004,
      hostReceiptIds: ['receipt-2'], replaySamples: 3, replaySuccesses: 3, falseSuccesses: 1,
    })?.status).toBe('unverified');
    expect(publishActionCircuit({ circuitId: candidate!.eventId, scope })).toBeNull();
  });

  it('summarizes bounded replay samples deterministically', () => {
    expect(summarizeCircuitReplay([
      { succeeded: true }, { succeeded: false }, { succeeded: true, falseSuccess: true },
    ])).toEqual({ replaySamples: 3, replaySuccesses: 2, falseSuccesses: 1, successRate: 0.6667 });
  });
});
