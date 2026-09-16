import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ RELATIONSHIP_ENABLED: true }),
}));

import { buildScopedWorldProjection } from '../../../src/agent/world-projection.js';

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), `migrations/${name}`), 'utf8');
}

beforeEach(() => {
  db = new Database(':memory:');
  for (const name of [
    '0005_user_profiles.sql',
    '0018_self_history_relationship.sql',
    '0025_profile_sections.sql',
    '0055_goals.sql',
    '0056_self_model.sql',
    '0062_world_entities.sql',
    '0063_group_norms.sql',
    '0104_group_norm_revisions.sql',
    '0105_relationship_revisions.sql',
    '0083_core_belief_view.sql',
    '0090_scope_boundaries.sql',
    '0096_world_model_history.sql',
  ]) db.exec(migration(name));
});

describe('scoped Self/Person/Group/World projection', () => {
  it('assembles bounded hypotheses with provenance and expiry', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)').run('先给结论，再补细节', 'feedback:event-1', now);
    db.prepare(
      `INSERT INTO user_profiles (chat_id, uid, profile_prompt, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(-100, 7, '偏好短句，关注数据库', now);
    db.prepare(
      `INSERT INTO chat_relationships (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(-100, 7, 35, 12, now, '', now);
    db.prepare(
      `INSERT INTO group_norms (chat_id, norms, sample_count, last_updated_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(-100, JSON.stringify(['短句为主', '技术问题先结论']), 30, now, now);
    db.prepare(
      `INSERT INTO world_entities
       (name, kind, properties, source_chat_id, last_updated_at, created_at, scope_key, visibility,
        current_revision, source_event_id, confidence, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('project-x', 'project', JSON.stringify({ status: 'active' }), -100, now, now, 'chat:-100', 'chat', 2, 'event-world-1', 0.85, now + 3600);

    const projection = buildScopedWorldProjection({ visibility: 'task', chatId: -100, taskId: 'task-1', userId: 7 });
    expect(projection.self[0]).toMatchObject({ kind: 'self', scopeKey: 'global', status: 'unverified', evidence: ['feedback:event-1'] });
    expect(projection.person[0]).toMatchObject({ kind: 'person', scopeKey: 'user:7@chat:-100', status: 'unverified', expiresAt: now + 30 * 24 * 3600, evidence: ['profile:-100:7', 'chat_relationships:-100:7'] });
    expect(projection.person[0]?.statement).toContain('互动记录：已互动 12 次');
    expect(projection.group[0]).toMatchObject({ kind: 'group', scopeKey: 'chat:-100', status: 'unverified', expiresAt: now + 6 * 3600 });
    expect(projection.world[0]).toMatchObject({ kind: 'world', subject: 'project:project-x', source: 'world_event:event-world-1', scopeKey: 'chat:-100', confidence: 0.85 });
    expect(projection.worldEntities).toHaveLength(1);
    expect(projection.uncertainties).toEqual([]);
  });

  it('does not cross a chat boundary and rejects expired hypotheses', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO user_profiles (chat_id, uid, profile_prompt, updated_at) VALUES (?, ?, ?, ?)').run(-200, 7, '只属于另一个群', now);
    db.prepare('INSERT INTO group_norms (chat_id, norms, sample_count, last_updated_at, created_at) VALUES (?, ?, ?, ?, ?)').run(-100, JSON.stringify(['旧规范']), 2, now - 7 * 3600, now - 7 * 3600);
    db.prepare('INSERT INTO world_entities (name, kind, properties, source_chat_id, last_updated_at, created_at, scope_key, visibility, current_revision, confidence, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'private-project', 'project', JSON.stringify({ owner: 'chat-200' }), -200, now, now, 'chat:-200', 'chat', 1, 0.9, now + 3600,
    );

    const projection = buildScopedWorldProjection({ visibility: 'chat', chatId: -100, userId: 7 });
    expect(projection.person).toEqual([]);
    expect(projection.world).toEqual([]);
    expect(projection.group[0]).toMatchObject({ status: 'stale' });
    expect(projection.uncertainties).toContain('群规范可能已过期（chat:-100）。');
  });

  it('keeps Self available globally but refuses unscoped person/group/world data', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)').run('遇到不确定先核实', 'feedback:event-2', now);
    const projection = buildScopedWorldProjection({ visibility: 'global' });
    expect(projection.self).toHaveLength(1);
    expect(projection.person).toEqual([]);
    expect(projection.group).toEqual([]);
    expect(projection.world).toEqual([]);
    expect(projection.uncertainties).toContain('工作区缺少有效 chat scope，已拒绝 Person/Group/World 投影。');
  });

  it('reconstructs world and self state at an event timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const asOf = now - 50;
    db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)').run('锚点之前的自我笔记', 'event:self-old', asOf - 10);
    db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)').run('锚点之后的新笔记', 'event:self-new', now);
    db.prepare('INSERT INTO user_profiles (chat_id, uid, profile_prompt, updated_at) VALUES (?, ?, ?, ?)')
      .run(-100, 7, '锚点前的用户画像', asOf - 20);
    db.prepare(
      `INSERT INTO chat_relationships
       (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(-100, 7, 35, 4, asOf - 20, '', asOf - 20);
    db.prepare(
      `UPDATE chat_relationships
          SET affinity = ?, interaction_count = ?, last_interaction_at = ?, updated_at = ?
        WHERE chat_id = ? AND uid = ?`,
    ).run(80, 9, now, now, -100, 7);
    db.prepare(
      `INSERT INTO world_entities
       (name, kind, properties, source_chat_id, last_updated_at, created_at, scope_key, visibility,
        current_revision, source_event_id, confidence, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('project-history', 'project', JSON.stringify({ status: 'current' }), -100, now, asOf - 100, 'chat:-100', 'chat', 2, 'event-new', 0.9, null);
    const entityId = Number((db.prepare('SELECT id FROM world_entities WHERE name = ?').get('project-history') as { id: number }).id);
    db.prepare(
      `INSERT INTO world_entity_revisions
       (entity_id, revision, scope_key, source_event_id, properties_json, confidence, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'superseded', ?, ?)`,
    ).run(entityId, 1, 'chat:-100', 'event-old', JSON.stringify({ status: 'planned' }), 0.6, asOf - 10, null);
    db.prepare(
      `INSERT INTO world_entity_revisions
       (entity_id, revision, scope_key, source_event_id, properties_json, confidence, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(entityId, 2, 'chat:-100', 'event-new', JSON.stringify({ status: 'current' }), 0.9, now, null);

    const projection = buildScopedWorldProjection(
      { visibility: 'user', chatId: -100, userId: 7 },
      { asOf, maxSelf: 5, maxWorld: 5 },
    );
    expect(projection.self.map((item) => item.statement)).toEqual(['锚点之前的自我笔记']);
    expect(projection.world[0]).toMatchObject({ source: 'world_event:event-old', confidence: 0.6 });
    expect(projection.world[0]?.statement).toContain('status=planned');
    expect(projection.worldEntities[0]?.currentRevision).toBe(1);
    expect(projection.person[0]?.statement).toContain('截至事件锚点已互动 4 次');
    expect(projection.person[0]?.statement).not.toContain('9 次');
    expect(projection.person[0]?.evidence).toContain('chat_relationship_revisions:-100:7');
    expect(projection.uncertainties).not.toContain('用户关系统计缺少历史 revision，事件锚点不读取当前关系（uid:7@chat:-100）。');
  });
});
