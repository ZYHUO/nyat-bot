import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildHostCapabilitySnapshot } from '../../../src/agent/nyatos-contracts.js';
import {
  getLatestCapabilitySnapshot,
  getLatestInnerState,
  listAffectEpisodes,
  recordAffectEpisode,
  recordCapabilitySnapshot,
  recordInnerState,
  recordMissionProposal,
} from '../../../src/agent/nyatos-state.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
});

afterEach(() => db.close());

describe('NyatOS durable state projections', () => {
  it('records and reads host inner state and capability by exact chat scope', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    expect(recordInnerState({
      schema: 'inner_state.v1',
      attention: 0.8,
      energy: 0.6,
      curiosity: 0.7,
      connection: 0.5,
      confidence: 0.4,
      uncertainty: 0.3,
      unresolved: ['latest_user_question'],
      wants: ['understanding'],
      aversions: [],
      commitments: [],
      currentNeed: 'feedback',
      updatedAt: 1_700_000_001,
    }, { scope, causationId: 'telegram:-100:message:7' })?.inserted).toBe(true);

    const capability = buildHostCapabilitySnapshot({
      scope,
      observedAt: 1_700_000_001,
      chatKind: 'group',
      admin: {
        status: 'administrator',
        canDeleteMessages: true,
        canPinMessages: true,
        canManageChat: false,
        canManageTopics: true,
        canRestrictMembers: false,
        canInviteUsers: true,
        isAnonymous: false,
      },
    });
    expect(recordCapabilitySnapshot(capability, { causationId: 'telegram:-100:message:7' })?.inserted).toBe(true);

    expect(getLatestInnerState(scope)?.value).toMatchObject({ currentNeed: 'feedback', attention: 0.8 });
    expect(getLatestCapabilitySnapshot(scope)?.value).toMatchObject({
      chatKind: 'group',
      observed: { canSendText: null },
      admin: { status: 'administrator', canManageTopics: true },
    });
    expect(getLatestInnerState({ visibility: 'chat', chatId: -200 })).toBeNull();
  });

  it('deduplicates repeated observations and preserves model proposals as proposals', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    const episode = {
      schema: 'affect_episode.v1' as const,
      id: 'affect-1',
      scope,
      kind: 'curiosity' as const,
      intensity: 0.5,
      valence: 0.2,
      arousal: 0.4,
      startedAt: 1_700_000_000,
      updatedAt: 1_700_000_002,
      status: 'active' as const,
      triggerEventIds: ['telegram:-100:message:8'],
      expressionState: 'candidate feeling',
    };
    expect(recordAffectEpisode(episode).inserted).toBe(true);
    expect(recordAffectEpisode(episode).inserted).toBe(false);
    expect(listAffectEpisodes(scope)).toHaveLength(1);

    const mission = {
      schema: 'mission_proposal.v1' as const,
      objective: 'observe whether a quiet group thread resumes',
      scope,
      successChecks: ['host observes a follow-up message'],
      watchFor: ['new human message'],
      budget: { maxAttempts: 2, maxWallClockSec: 3600 },
      status: 'proposed' as const,
    };
    expect(recordMissionProposal(mission)?.inserted).toBe(true);
    const row = db.prepare("SELECT source, type, fact_json FROM cognitive_events WHERE type = 'mission_proposed'").get() as { source: string; type: string; fact_json: string };
    expect(row).toMatchObject({ source: 'model', type: 'mission_proposed' });
    expect(row.fact_json).toContain('proposed');
    expect(row.fact_json).not.toContain('verified');
  });
});
