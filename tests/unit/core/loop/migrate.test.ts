import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
const envStore: Record<string, unknown> = {
  CORE_BELIEF_VIEW_ENABLED: true,
  CORE_BLACKBOARD_ENABLED: true,
  CORE_PERMISSION_GATE_ENABLED: false,
  CORE_V2_ENABLED: true,
  CORE_V2_CHAT_IDS: '',
  CORE_DUAL_WRITE: true,
  BELIEF_VIEW_INJECT_MAX: 4,
  BELIEF_TTL_DEFAULT_SEC: 7776000,
  JUDGE_KNOWLEDGE_ENABLED: false,
  JUDGE_KNOWLEDGE_PERMANENT: true,
  JUDGE_KNOWLEDGE_GROUP: true,
};

vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/env.js', () => ({ env: () => envStore }));
vi.mock('../../../../src/knowledge/manager.js', () => ({ getKnowledge: () => '' }));

import { upsertBelief, getActiveBeliefs } from '../../../../src/core/beliefs/store.js';
import {
  syncGroupNorms,
  syncUserProfile,
  syncWorldEntity,
  syncGoal,
} from '../../../../src/core/migrate.js';

function seedOldTables(): void {
  db.exec(readFileSync('migrations/0063_group_norms.sql', 'utf8'));
  db.exec(readFileSync('migrations/0005_user_profiles.sql', 'utf8'));
  db.exec(readFileSync('migrations/0062_world_entities.sql', 'utf8'));
  db.exec(readFileSync('migrations/0055_goals.sql', 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO group_norms (chat_id, norms, sample_count, last_updated_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(-100, JSON.stringify(['玩梗', '短句']), 10, now, now);
  db.prepare(
    `INSERT INTO user_profiles (chat_id, uid, username, full_name, profile_prompt, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(-100, 42, 'alice', 'Alice', '喜欢川菜；熬夜党', now);
  db.prepare(
    `INSERT INTO world_entities (name, kind, properties, last_updated_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('KARDS', 'topic', '{}', now, now);
  db.prepare(
    `INSERT INTO goals (topic, origin, chat_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('兑现承诺: 明天带券来', 'test', -100, 'active', now, now);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
  db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));
  seedOldTables();
  envStore['CORE_DUAL_WRITE'] = true;
});

describe('phase2 dual-write', () => {
  it('syncGroupNorms: norms → group.norm belief', () => {
    syncGroupNorms(-100);
    const rows = getActiveBeliefs('group.norm');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain('玩梗');
    expect(rows[0]!.confidence).toBe(0.5);
  });

  it('syncUserProfile: profile_prompt → person.interest belief', () => {
    syncUserProfile(-100, 42);
    const rows = getActiveBeliefs('person.interest');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain('川菜');
  });

  it('syncWorldEntity: entity → entity.status belief', () => {
    syncWorldEntity(1);
    expect(getActiveBeliefs('entity.status')).toHaveLength(1);
  });

  it('syncGoal: active goal → goal.state；非 active 不写', () => {
    syncGoal(1);
    expect(getActiveBeliefs('goal.state')).toHaveLength(1);
    db.prepare(`UPDATE goals SET status='achieved' WHERE id=1`).run();
    db.prepare(
      `INSERT INTO goals (topic, origin, chat_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('done thing', 'test', -100, 'achieved', 1, 1);
    syncGoal(2);
    expect(getActiveBeliefs('goal.state')).toHaveLength(1);
  });

  it('双写关 → 零写入', () => {
    envStore['CORE_DUAL_WRITE'] = false;
    syncGroupNorms(-100);
    syncUserProfile(-100, 42);
    expect(getActiveBeliefs('group.norm')).toHaveLength(0);
    expect(getActiveBeliefs('person.interest')).toHaveLength(0);
    envStore['CORE_DUAL_WRITE'] = true;
  });

  it('重复同步不插新行（upsert 去重）', () => {
    syncGroupNorms(-100);
    syncGroupNorms(-100);
    expect(getActiveBeliefs('group.norm')).toHaveLength(1);
  });

  it('空内容不写（无 evidence 不落库）', () => {
    db.prepare(`UPDATE user_profiles SET profile_prompt=NULL WHERE chat_id=-100 AND uid=42`).run();
    syncUserProfile(-100, 42);
    expect(getActiveBeliefs('person.interest')).toHaveLength(0);
  });

  it('旧表更新 → belief summary 跟着变（silent-change 可见）', () => {
    syncGroupNorms(-100);
    db.prepare(`UPDATE group_norms SET norms=? WHERE chat_id=-100`).run(
      JSON.stringify(['玩梗', '短句', '不聊政治']),
    );
    syncGroupNorms(-100);
    const rows = getActiveBeliefs('group.norm');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain('不聊政治');
  });
});

describe('phase2 belief budget', () => {
  it('upsert 200 字截断 + 预算外不注入（assembleSystemPrompt 侧）', async () => {
    for (let i = 0; i < 6; i++) {
      upsertBelief({
        sourceTable: 'eval',
        sourceRowId: i,
        predicate: 'group.norm',
        summary: `norm ${i}`,
        evidence: ['msg:1'],
      });
    }
    const { assembleSystemPrompt } = await import('../../../../src/core/prompt/system.js');
    const st = {
      identity: 'x',
      beliefs: getActiveBeliefs('group.norm'),
      knowledge: '',
      agenda: [],
      skills: [],
      drives: {},
      context: { chatId: -100, messageId: 1 },
    } as never as Parameters<typeof assembleSystemPrompt>[0];
    const p = assembleSystemPrompt(st);
    // BELIEF_VIEW_INJECT_MAX=4 → 最多 4 条
    expect(p.beliefCount).toBe(4);
  });
});
