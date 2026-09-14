import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getActiveBeliefs, upsertBelief } from '../../../../src/core/beliefs/store.js';

beforeEach(() => {
  db = new Database(':memory:');
  for (const migration of ['0005_user_profiles.sql', '0044_person_identity.sql', '0055_goals.sql', '0062_world_entities.sql', '0083_core_belief_view.sql', '0090_scope_boundaries.sql']) {
    db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  }
});

describe('scoped beliefs', () => {
  it('keeps same-user profiles separate per chat', () => {
    upsertBelief({
      sourceTable: 'user_profiles', sourceRowId: 7, predicate: 'person.interest', summary: '群 A', evidence: ['profile:-100:7'],
      scope: { visibility: 'user', userId: 7, chatId: -100 },
    });
    upsertBelief({
      sourceTable: 'user_profiles', sourceRowId: 7, predicate: 'person.interest', summary: '群 B', evidence: ['profile:-200:7'],
      scope: { visibility: 'user', userId: 7, chatId: -200 },
    });
    expect(getActiveBeliefs('person.interest', { scope: { visibility: 'chat', chatId: -100, userId: 7 } }).map((b) => b.summary)).toEqual(['群 A']);
    expect(getActiveBeliefs('person.interest', { scope: { visibility: 'chat', chatId: -200, userId: 7 } }).map((b) => b.summary)).toEqual(['群 B']);
  });

  it('does not expose another chat norm to a scoped read', () => {
    upsertBelief({ sourceTable: 'group_norms', sourceRowId: -100, predicate: 'group.norm', summary: 'A norm', evidence: ['norms:-100'], scope: { visibility: 'chat', chatId: -100 } });
    upsertBelief({ sourceTable: 'group_norms', sourceRowId: -200, predicate: 'group.norm', summary: 'B norm', evidence: ['norms:-200'], scope: { visibility: 'chat', chatId: -200 } });
    expect(getActiveBeliefs('group.norm', { scope: { visibility: 'chat', chatId: -100 } }).map((b) => b.summary)).toEqual(['A norm']);
  });
});
