import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordMissionProposal } from '../../../src/agent/nyatos-state.js';
import {
  checkpointProcess,
  claimDueMissionWakes,
  getMissionContinuity,
  listDueProcessWakes,
  listMissionContinuity,
  requestMissionWake,
  requestProcessWake,
  recordMissionObservation,
  runCognitiveContinuityTick,
  stopProcess,
} from '../../../src/agent/cognitive-continuity.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

afterEach(() => db.close());

describe('cognitive continuity ledger', () => {
  it('wakes a proposed mission once, then requires host evidence to close it', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    const base = Math.floor(Date.now() / 1000);
    const proposal = recordMissionProposal({
      schema: 'mission_proposal.v1',
      objective: 'watch for a follow-up',
      scope,
      successChecks: ['host observes a human follow-up'],
      watchFor: ['new message'],
      budget: { maxAttempts: 2, maxWallClockSec: 3600 },
      status: 'proposed',
    });
    expect(proposal?.inserted).toBe(true);
    expect(claimDueMissionWakes(base + 10)).toHaveLength(1);
    expect(claimDueMissionWakes(base + 10)).toHaveLength(0);
    const pending = getMissionContinuity(proposal!.eventId, scope);
    expect(pending).toMatchObject({ status: 'wake_requested' });

    expect(recordMissionObservation({
      missionId: proposal!.eventId,
      scope,
      status: 'verified',
      observedAt: base + 20,
      evidenceEventIds: ['telegram:-100:message:99'],
      checksPassed: 1,
      checksTotal: 1,
      summary: 'follow-up observed',
    })?.inserted).toBe(true);
    expect(getMissionContinuity(proposal!.eventId, scope)).toMatchObject({ status: 'verified', due: false });
    expect(claimDueMissionWakes(base + 30)).toEqual([]);
  });

  it('keeps mission scopes isolated and downgrades unsupported verification', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    const proposal = recordMissionProposal({
      schema: 'mission_proposal.v1', objective: 'scoped mission', scope,
      successChecks: ['one host check'], watchFor: [], budget: { maxAttempts: 1, maxWallClockSec: 600 }, status: 'proposed',
    });
    expect(proposal).not.toBeNull();
    expect(recordMissionObservation({
      missionId: proposal!.eventId,
      scope: { visibility: 'chat', chatId: -200 },
      status: 'verified', observedAt: 1_700_000_001, evidenceEventIds: ['x'], checksPassed: 1, checksTotal: 1,
    })).toBeNull();
    expect(recordMissionObservation({
      missionId: proposal!.eventId, scope, status: 'verified', observedAt: 1_700_000_002,
      evidenceEventIds: [], checksPassed: 0, checksTotal: 0,
    })?.inserted).toBe(true);
    expect(listMissionContinuity({ visibility: 'chat', chatId: -200 })).toEqual([]);
    expect(listMissionContinuity(scope)[0]?.status).toBe('observed');
  });

  it('persists process wakes across a checkpoint and host stop', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    const base = Math.floor(Date.now() / 1000);
    const wake = requestProcessWake({
      processId: 'mission:one', kind: 'strategist', scope, wakeAt: base - 1, reason: 'mission_due',
    });
    expect(wake?.inserted).toBe(true);
    expect(listDueProcessWakes(base)).toHaveLength(1);
    expect(checkpointProcess({
      processId: 'mission:one', wakeEventId: wake!.eventId, scope, status: 'waiting', nextWakeAt: base + 1,
    })?.inserted).toBe(true);
    expect(listDueProcessWakes(base + 1)).toEqual([]);

    const second = requestProcessWake({
      processId: 'mission:one', kind: 'strategist', scope, wakeAt: base + 61, reason: 'retry',
    });
    expect(second?.inserted).toBe(true);
    expect(stopProcess({ processId: 'mission:one', scope, recordedAt: base + 62 })?.inserted).toBe(true);
    expect(listDueProcessWakes(base + 62)).toEqual([]);
  });

  it('continuity tick links a due mission to a durable strategist process wake', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    const proposal = recordMissionProposal({
      schema: 'mission_proposal.v1', objective: 'tick mission', scope,
      successChecks: ['host evidence'], watchFor: [], budget: { maxAttempts: 1, maxWallClockSec: 600 }, status: 'proposed',
    });
    expect(proposal).not.toBeNull();
    expect(runCognitiveContinuityTick(1_700_000_000)).toEqual({ missionsWoken: 1, processesWoken: 1 });
    expect(runCognitiveContinuityTick(1_700_000_000)).toEqual({ missionsWoken: 0, processesWoken: 0 });
    expect(requestMissionWake({ missionId: proposal!.eventId, scope, wakeAt: 1_700_000_000 })?.inserted).toBe(false);
  });
});
