import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/tracking/scratchpad.js', () => ({ getScratch: vi.fn(async () => []) }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({
  listOpenDebtsScoped: vi.fn(() => []),
  findRelatedDebtsScoped: vi.fn(() => []),
  findRelatedDebtsScopedWithSemantic: vi.fn(async () => []),
}));
vi.mock('../../../src/subagent/task-store.js', () => ({ loadCodeActTask: vi.fn(async () => null) }));
vi.mock('../../../src/context-engine/index.js', () => ({
  getContextEngine: () => ({ assemble: async (providers: Array<{ provide: () => { text: string } }>) => ({
    prompt: providers.map((provider) => provider.provide().text).join('\n'),
  }) }),
}));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { recordSocialInteraction } from '../../../src/agent/social-event-graph.js';
import { buildCognitiveWorkspace } from '../../../src/agent/cognitive-workspace.js';

beforeEach(() => {
  db = new Database(':memory:');
  for (const name of [
    '0005_user_profiles.sql',
    '0025_profile_sections.sql',
    '0055_goals.sql',
    '0056_self_model.sql',
    '0062_world_entities.sql',
    '0063_group_norms.sql',
    '0065_tasks.sql',
    '0072_task_evidence.sql',
    '0083_core_belief_view.sql',
    '0084_core_blackboard.sql',
    '0088_bot_predictions.sql',
    '0089_cognitive_events.sql',
    '0090_scope_boundaries.sql',
    '0096_world_model_history.sql',
    '0102_social_event_graph.sql',
  ]) db.exec(readFileSync(`migrations/${name}`, 'utf8'));
});

describe('event-anchored cognitive workspace', () => {
  it('does not inject newer goals or predictions and reconstructs historical world state', async () => {
    const now = Math.floor(Date.now() / 1000);
    const asOf = now - 50;
    const anchor = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'chat', chatId: -100 },
      occurredAt: asOf,
      correlationId: 'workspace-asof',
      fact: { kind: 'checkpoint_saved' },
    })!.event;
    recordSocialInteraction({ chatId: -100, fromUid: 7, toUid: 8, kind: 'reply', messageId: 10, occurredAt: asOf - 1 });
    recordSocialInteraction({ chatId: -100, fromUid: 7, toUid: 8, kind: 'reply', messageId: 11, occurredAt: asOf + 1 });

    db.prepare(
      `INSERT INTO goals (topic, origin, chat_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run('锚点前目标', 'test', -100, asOf - 10, asOf - 5);
    db.prepare(
      `INSERT INTO goals (topic, origin, chat_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run('锚点后目标', 'test', -100, now, now);

    db.prepare(
      `INSERT INTO bot_predictions
       (chat_id, task_id, message_id, source, prediction, predicted_sentiment, actual_sentiment, created_at, resolved_at)
       VALUES (?, ?, ?, 'system_prior', ?, ?, ?, ?, ?)`,
    ).run(-100, null, 1, '锚点前预测', 0.5, 0.8, asOf - 10, asOf + 10);
    db.prepare(
      `INSERT INTO bot_predictions
       (chat_id, task_id, message_id, source, prediction, predicted_sentiment, created_at)
       VALUES (?, ?, ?, 'system_prior', ?, ?, ?)`,
    ).run(-100, null, 2, '锚点后预测', 0.5, now);

    db.prepare(
      `INSERT INTO world_entities
       (name, kind, properties, source_chat_id, last_updated_at, created_at, scope_key, visibility,
        current_revision, source_event_id, confidence, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('历史项目', 'project', JSON.stringify({ status: 'current' }), -100, now, asOf - 100, 'chat:-100', 'chat', 2, 'event-new', 0.9, null);
    const entityId = Number((db.prepare('SELECT id FROM world_entities WHERE name = ?').get('历史项目') as { id: number }).id);
    db.prepare(
      `INSERT INTO world_entity_revisions
       (entity_id, revision, scope_key, source_event_id, properties_json, confidence, status, created_at)
       VALUES (?, 1, 'chat:-100', ?, ?, ?, 'superseded', ?)`,
    ).run(entityId, 'event-old', JSON.stringify({ status: 'planned' }), 0.6, asOf - 10);
    db.prepare(
      `INSERT INTO world_entity_revisions
       (entity_id, revision, scope_key, source_event_id, properties_json, confidence, status, created_at)
       VALUES (?, 2, 'chat:-100', ?, ?, ?, 'active', ?)`,
    ).run(entityId, 'event-new', JSON.stringify({ status: 'current' }), 0.9, now);

    const snapshot = await buildCognitiveWorkspace({ chatId: -100, asOfEventId: anchor.id });
    expect(snapshot.activeGoals).toContain('锚点前目标');
    expect(snapshot.activeGoals).not.toContain('锚点后目标');
    expect(snapshot.predictions.map((prediction) => prediction.prediction)).toContain('锚点前预测');
    expect(snapshot.predictions.map((prediction) => prediction.prediction)).not.toContain('锚点后预测');
    expect(snapshot.worldProjection?.world[0]).toMatchObject({ source: 'world_event:event-old', confidence: 0.6 });
    expect(snapshot.worldProjection?.world[0]?.statement).toContain('status=planned');
    expect(snapshot.socialGraph?.interactionCount).toBe(1);
    expect(snapshot.socialGraph?.edges[0]).toMatchObject({ fromUid: 7, toUid: 8, interactionCount: 1 });
    expect(snapshot.provenance.some((item) => item.source === `event:${anchor.id}`)).toBe(true);
  });

  it('rejects an anchor from another chat instead of silently using historical state', async () => {
    const now = Math.floor(Date.now() / 1000);
    const anchor = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'chat', chatId: -200 },
      occurredAt: now,
      correlationId: 'workspace-asof-other-chat',
      fact: { kind: 'checkpoint_saved' },
    })!.event;
    const snapshot = await buildCognitiveWorkspace({ chatId: -100, asOfEventId: anchor.id });
    expect(snapshot.uncertainties).toContain('工作区锚点事件与当前 scope 不一致，已拒绝历史投影。');
    expect(snapshot.provenance.some((item) => item.source === `event:${anchor.id}`)).toBe(false);
  });
});
