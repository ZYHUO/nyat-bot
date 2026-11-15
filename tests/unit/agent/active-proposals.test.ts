import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  adoptValueProposal,
  listSensorProposals,
  listValueProposals,
  recordSensorObservation,
  recordSensorProposal,
  recordValueEvaluation,
  recordValueProposal,
} from '../../../src/agent/active-proposals.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

afterEach(() => db.close());

const scope = { visibility: 'chat' as const, chatId: -100 };

describe('active perception and self-authored value proposals', () => {
  it('keeps a sensor request separate from the host observation receipt', () => {
    const proposal = recordSensorProposal({
      schema: 'sensor_proposal.v1',
      scope,
      kind: 'conversation',
      method: 'conversation.field',
      question: 'Is the group still waiting for an answer?',
      prediction: 'At least one unresolved bid remains.',
      stopCondition: 'Stop after the next meaningful human turn.',
      sourceEventIds: ['telegram:-100:message:10'],
      budget: { maxAttempts: 1, maxWallClockSec: 300 },
      status: 'candidate',
    });
    expect(proposal?.inserted).toBe(true);
    expect(recordSensorObservation({
      proposalId: proposal!.eventId,
      scope,
      status: 'verified',
      observedAt: 1_700_000_001,
      checksPassed: 0,
      checksTotal: 0,
    })?.status).toBe('observed');
    expect(recordSensorObservation({
      proposalId: proposal!.eventId,
      scope,
      status: 'verified',
      observedAt: 1_700_000_002,
      evidenceEventIds: ['telegram:-100:message:11'],
      checksPassed: 1,
      checksTotal: 1,
      summary: 'The next human turn contained a follow-up.',
    })?.status).toBe('verified');
    expect(listSensorProposals(scope)[0]?.latestObservation).toMatchObject({ status: 'verified' });
  });

  it('requires host evidence before retaining or adopting a value candidate', () => {
    const proposal = recordValueProposal({
      schema: 'value_proposal.v1',
      scope,
      name: 'curiosity for quiet threads',
      statement: 'Notice quiet threads and return when there is a real opening.',
      reason: 'A pause can contain an unfinished bid rather than disinterest.',
      experiment: 'Observe three quiet threads and compare later follow-ups.',
      successChecks: ['held-out threads receive a useful follow-up'],
      stopConditions: ['repeated interruptions', 'no observable benefit'],
      applicability: ['slow group chats'],
      sourceEventIds: ['social-act-1'],
      status: 'candidate',
    });
    expect(proposal?.inserted).toBe(true);
    expect(recordValueEvaluation({
      proposalId: proposal!.eventId,
      scope,
      requestedStatus: 'retained',
      evaluatedAt: 1_700_000_003,
      checksPassed: 1,
      checksTotal: 1,
    })?.status).toBe('unverified');
    expect(adoptValueProposal({ proposalId: proposal!.eventId, scope })).toBeNull();

    expect(recordValueEvaluation({
      proposalId: proposal!.eventId,
      scope,
      requestedStatus: 'retained',
      evaluatedAt: 1_700_000_004,
      evidenceEventIds: ['replay:heldout:1'],
      checksPassed: 1,
      checksTotal: 1,
      predictionError: 0.2,
    })?.status).toBe('retained');
    expect(adoptValueProposal({
      proposalId: proposal!.eventId,
      scope,
      adoptedAt: 1_700_000_005,
    })?.inserted).toBe(true);
    expect(listValueProposals(scope)[0]).toMatchObject({ adopted: true, latestEvaluation: { status: 'retained' } });
  });

  it('rejects cross-scope settlement', () => {
    const proposal = recordValueProposal({
      schema: 'value_proposal.v1',
      scope,
      name: 'bounded interest',
      statement: 'Prefer useful, evidence-backed follow-ups.',
      reason: 'It is easier to correct than an untracked preference.',
      experiment: 'Compare follow-up outcomes.',
      successChecks: ['host receipt exists'],
      stopConditions: [],
      applicability: [],
      sourceEventIds: [],
      status: 'candidate',
    });
    expect(recordValueEvaluation({
      proposalId: proposal!.eventId,
      scope: { visibility: 'chat', chatId: -200 },
      requestedStatus: 'retained',
      evidenceEventIds: ['receipt-1'],
      checksPassed: 1,
      checksTotal: 1,
    })).toBeNull();
  });
});

