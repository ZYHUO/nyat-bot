import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { projectCognitiveEvent } from '../../../src/agent/cognitive-projector.js';
import { findEntities, listEntityRevisions } from '../../../src/agent/world-state.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0062_world_entities.sql', 'utf8'));
  db.exec(readFileSync('migrations/0055_goals.sql', 'utf8'));
  db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
  db.exec(readFileSync('migrations/0090_scope_boundaries.sql', 'utf8'));
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0096_world_model_history.sql', 'utf8'));
});

describe('world-change cognitive projection', () => {
  it('projects a host fact into a scoped entity and immutable revision', () => {
    const appended = appendCognitiveEvent({
      type: 'world_change',
      source: 'host',
      scope: { visibility: 'chat', chatId: -100 },
      correlationId: 'world-1',
      fact: {
        entityName: 'project-x',
        entityKind: 'project',
        properties: { status: 'active', owner: 'team-a' },
        confidence: 0.85,
      },
    });
    const event = appended!.event;
    expect(projectCognitiveEvent(event, { createDebts: false })).toMatchObject({ worldChangeProjected: 1, ignored: false });
    expect(findEntities('project-x', undefined, 4, { visibility: 'chat', chatId: -100 })).toMatchObject([
      { name: 'project-x', properties: { status: 'active', owner: 'team-a' }, confidence: 0.85 },
    ]);
    expect(listEntityRevisions(1, 10, { visibility: 'chat', chatId: -100 })).toMatchObject([
      { revision: 1, sourceEventId: event.id, confidence: 0.85, status: 'active' },
    ]);
  });

  it('is idempotent, rejects model/global spoofing, and preserves chat isolation', () => {
    const valid = appendCognitiveEvent({
      type: 'world_change',
      source: 'tool',
      scope: { visibility: 'chat', chatId: -200 },
      correlationId: 'world-2',
      fact: { entityName: 'same-name', entityKind: 'topic', properties: { status: 'chat-b' } },
    })!.event;
    expect(projectCognitiveEvent(valid, { createDebts: false }).worldChangeProjected).toBe(1);
    expect(projectCognitiveEvent(valid, { createDebts: false }).worldChangeProjected).toBe(0);
    expect(listEntityRevisions(1, 10, { visibility: 'chat', chatId: -200 })).toHaveLength(1);
    expect(findEntities('same-name', undefined, 4, { visibility: 'chat', chatId: -100 })).toEqual([]);

    const modelGlobal = appendCognitiveEvent({
      type: 'world_change',
      source: 'model',
      scope: { visibility: 'global' },
      correlationId: 'world-3',
      fact: { entityName: 'spoofed', entityKind: 'topic', properties: { status: 'global' } },
    })!.event;
    expect(projectCognitiveEvent(modelGlobal, { createDebts: false })).toMatchObject({ worldChangeProjected: 0, ignored: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM world_entities').get()).toEqual({ count: 1 });
  });

  it('rejects malformed property values instead of writing an unsafe snapshot', () => {
    const malformed = appendCognitiveEvent({
      type: 'world_change',
      source: 'host',
      scope: { visibility: 'chat', chatId: -300 },
      correlationId: 'world-4',
      fact: { entityName: 'bad', entityKind: 'topic', properties: { ok: 42, '\u0000bad': 'x' } },
    })!.event;
    expect(projectCognitiveEvent(malformed, { createDebts: false })).toMatchObject({ worldChangeProjected: 0, ignored: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM world_entities').get()).toEqual({ count: 0 });
  });
});

