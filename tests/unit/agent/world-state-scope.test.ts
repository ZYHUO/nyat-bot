import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { findEntities, upsertEntity } from '../../../src/agent/world-state.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0062_world_entities.sql', 'utf8'));
  db.exec(`
    ALTER TABLE world_entities ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE world_entities ADD COLUMN visibility TEXT NOT NULL DEFAULT 'global';
    DROP INDEX idx_world_entities_name_kind;
    CREATE UNIQUE INDEX idx_world_entities_name_kind_scope ON world_entities(name, kind, scope_key);
  `);
});

describe('scoped world state', () => {
  it('keeps same entity names separate per chat and permits global facts', () => {
    upsertEntity('project-x', 'project', { owner: 'A' }, -100);
    upsertEntity('project-x', 'project', { owner: 'B' }, -200);
    upsertEntity('shared', 'topic', { status: 'global' });
    expect(findEntities('project-x', undefined, 4, { visibility: 'chat', chatId: -100 }).map((e) => e.properties.owner)).toEqual(['A']);
    expect(findEntities('project-x', undefined, 4, { visibility: 'chat', chatId: -200 }).map((e) => e.properties.owner)).toEqual(['B']);
    expect(findEntities('shared', undefined, 4, { visibility: 'chat', chatId: -100 }).map((e) => e.properties.status)).toEqual(['global']);
  });

  it('keeps task entities visible only to that task and its chat', () => {
    upsertEntity('task-only', 'project', { owner: 'task-a' }, -100, { visibility: 'task', chatId: -100, taskId: 'task-a' });
    expect(findEntities('task-only', undefined, 4, { visibility: 'task', chatId: -100, taskId: 'task-a' }).map((e) => e.properties.owner)).toEqual(['task-a']);
    expect(findEntities('task-only', undefined, 4, { visibility: 'task', chatId: -100, taskId: 'task-b' })).toEqual([]);
    expect(findEntities('task-only', undefined, 4, { visibility: 'chat', chatId: -100 })).toEqual([]);
  });
});
