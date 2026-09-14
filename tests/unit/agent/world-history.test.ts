import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { findEntities, listEntityRevisions, upsertEntity } from '../../../src/agent/world-state.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0062_world_entities.sql', 'utf8'));
  db.exec(readFileSync('migrations/0055_goals.sql', 'utf8'));
  db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
  db.exec(readFileSync('migrations/0090_scope_boundaries.sql', 'utf8'));
  db.exec(readFileSync('migrations/0096_world_model_history.sql', 'utf8'));
});

describe('world model revision history', () => {
  it('keeps superseded revisions and records host provenance', () => {
    const scope = { visibility: 'chat' as const, chatId: -100 };
    const id = upsertEntity('project-x', 'project', { status: 'planned' }, -100, scope, {
      sourceEventId: 'event-1',
      confidence: 0.8,
    });
    expect(id).not.toBeNull();
    upsertEntity('project-x', 'project', { status: 'active' }, -100, scope, {
      sourceEventId: 'event-2',
      confidence: 0.9,
    });
    const revisions = listEntityRevisions(id!, 10, scope);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ revision: 2, sourceEventId: 'event-2', confidence: 0.9, status: 'active' });
    expect(revisions[1]).toMatchObject({ revision: 1, sourceEventId: 'event-1', confidence: 0.8, status: 'superseded' });
    expect(revisions[1]!.supersededBy).toBe(revisions[0]!.id);
    expect(db.prepare('SELECT current_revision, source_event_id, confidence FROM world_entities WHERE id = ?').get(id)).toEqual({
      current_revision: 2,
      source_event_id: 'event-2',
      confidence: 0.9,
    });
  });

  it('filters an expired current snapshot without deleting its history', () => {
    const scope = { visibility: 'chat' as const, chatId: -200 };
    const id = upsertEntity('expiring', 'topic', { status: 'temporary' }, -200, scope, {
      sourceEventId: 'event-expire',
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    expect(findEntities('expiring', undefined, 4, scope)).toEqual([]);
    expect(listEntityRevisions(id!, 10, scope)).toHaveLength(1);
  });

  it('does not expose another scope history', () => {
    const id = upsertEntity('same', 'topic', { owner: 'A' }, -300, { visibility: 'chat', chatId: -300 }, { sourceEventId: 'a' });
    expect(listEntityRevisions(id!, 10, { visibility: 'chat', chatId: -301 })).toEqual([]);
  });
});
