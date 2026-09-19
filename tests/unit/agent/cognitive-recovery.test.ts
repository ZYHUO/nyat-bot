import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    COGNITIVE_EVENTS_ENABLED: true,
    COGNITIVE_OUTBOX_ENABLED: false,
    COGNITIVE_KERNEL_ENABLED: true,
    COGNITIVE_KERNEL_RECOVERY_ENABLED: true,
  }),
}));

import { appendCognitiveEvent, listCognitiveEvents } from '../../../src/agent/cognitive-events.js';
import { getCognitiveCursor } from '../../../src/agent/cognitive-cursor.js';
import {
  KERNEL_RECOVERY_STREAM,
  recoverStaleKernelActions,
} from '../../../src/agent/cognitive-recovery.js';
import type { ActionEnvelope } from '../../../src/agent/cognitive-kernel.js';

const scope = { visibility: 'chat' as const, chatId: -100 };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0111_cognitive_cursors.sql', 'utf8'));
});

function proposal(id: string, createdAt: number, maxWallClockSec: number): ActionEnvelope {
  return {
    schema: 'action_envelope.v1',
    id,
    scope,
    triggerEventId: 'trigger-1',
    frameEventId: 'frame-1',
    lane: 'social',
    kind: 'speak',
    payload: {},
    budget: { maxAttempts: 2, maxWallClockSec },
    status: 'candidate',
    createdAt,
  };
}

function dispatch(id: string, at: number): void {
  const result = appendCognitiveEvent({
    type: 'action_envelope_transition',
    source: 'host',
    scope,
    occurredAt: at,
    correlationId: 'turn-1',
    dedupeKey: `dispatch:${id}`,
    fact: { schema: 'action_envelope_transition.v1', envelopeId: id, status: 'dispatched' },
  });
  expect(result).toBeTruthy();
}

function propose(id: string, createdAt: number, maxWallClockSec: number): void {
  const result = appendCognitiveEvent({
    type: 'action_envelope_proposed',
    source: 'model',
    scope,
    occurredAt: createdAt,
    correlationId: 'turn-1',
    dedupeKey: `proposal:${id}`,
    fact: { schema: 'action_envelope.v1', idempotencyKey: id, envelope: proposal(id, createdAt, maxWallClockSec) },
  });
  expect(result).toBeTruthy();
}

describe('kernel crash recovery', () => {
  it('closes a dispatch whose host budget expired, without re-sending it', () => {
    propose('env-old', 100, 60);
    dispatch('env-old', 101);

    const result = recoverStaleKernelActions({ now: 500, owner: 'test-worker' });
    expect(result).toMatchObject({ scopesScanned: 1, recovered: 1, openActions: 1 });
    expect(result.actions[0]).toMatchObject({
      envelopeId: 'env-old',
      dispatchedAt: 101,
      reason: 'recovery_stale_dispatch',
    });

    const outcomes = listCognitiveEvents({ scope, type: 'action_envelope_outcome' });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.fact).toMatchObject({
      envelopeId: 'env-old',
      status: 'interrupted',
      reason: 'recovery_stale_dispatch',
    });
    // The receipt must record that recovery did not produce a second send.
    expect((outcomes[0]?.fact['receipt'] as Record<string, unknown>)['resent']).toBe(false);
    expect((outcomes[0]?.fact['receipt'] as Record<string, unknown>)['recoveredBy']).toBe('test-worker');
  });

  it('leaves an action inside its budget open and does not advance the cursor past it', () => {
    propose('env-live', 400, 3600);
    dispatch('env-live', 401);

    const result = recoverStaleKernelActions({ now: 500, owner: 'test-worker' });
    expect(result.recovered).toBe(0);
    expect(result.openActions).toBe(0);
    expect(listCognitiveEvents({ scope, type: 'action_envelope_outcome' })).toHaveLength(0);
    // The cursor must not move past a live obligation, otherwise a later sweep
    // would skip the action once it does expire.
    expect(getCognitiveCursor({ scope, stream: KERNEL_RECOVERY_STREAM })?.eventId ?? null).toBeNull();
  });

  it('does not reopen an action that already has a terminal outcome', () => {
    propose('env-done', 100, 60);
    dispatch('env-done', 101);
    const closed = appendCognitiveEvent({
      type: 'action_envelope_outcome',
      source: 'host',
      scope,
      occurredAt: 110,
      correlationId: 'turn-1',
      dedupeKey: 'outcome:env-done',
      fact: { envelopeId: 'env-done', status: 'completed' },
    });
    expect(closed).toBeTruthy();

    const result = recoverStaleKernelActions({ now: 500, owner: 'test-worker' });
    expect(result.recovered).toBe(0);
    expect(listCognitiveEvents({ scope, type: 'action_envelope_outcome' })).toHaveLength(1);
  });

  it('is idempotent across repeated sweeps and respects a competing lease', () => {
    propose('env-once', 100, 60);
    dispatch('env-once', 101);

    const first = recoverStaleKernelActions({ now: 500, owner: 'worker-a' });
    expect(first.recovered).toBe(1);
    const second = recoverStaleKernelActions({ now: 600, owner: 'worker-a' });
    expect(second.recovered).toBe(0);
    expect(listCognitiveEvents({ scope, type: 'action_envelope_outcome' })).toHaveLength(1);
  });

  it('keeps scopes isolated: a stale action in one chat never closes another', () => {
    const otherScope = { visibility: 'chat' as const, chatId: -200 };
    propose('env-a', 100, 60);
    dispatch('env-a', 101);
    appendCognitiveEvent({
      type: 'action_envelope_proposed',
      source: 'model',
      scope: otherScope,
      occurredAt: 200,
      correlationId: 'turn-2',
      dedupeKey: 'proposal:env-b',
      fact: {
        schema: 'action_envelope.v1',
        idempotencyKey: 'env-b',
        envelope: { ...proposal('env-b', 200, 600), scope: otherScope },
      },
    });
    appendCognitiveEvent({
      type: 'action_envelope_transition',
      source: 'host',
      scope: otherScope,
      occurredAt: 201,
      correlationId: 'turn-2',
      dedupeKey: 'dispatch:env-b',
      fact: { envelopeId: 'env-b', status: 'dispatched' },
    });

    const result = recoverStaleKernelActions({ now: 500, owner: 'test-worker' });
    expect(result.recovered).toBe(1);
    const outcomes = listCognitiveEvents({ type: 'action_envelope_outcome' });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.chatId).toBe(-100);
  });
});
