// ────────────────────────────────────────
// Core v2 Phase 2 — 旧表 → Belief View 迁移映射 + 双写
//
// 设计：旧表继续写（唯一真相来源），每次旧表写入成功后，
// best-effort 同步一条 belief（读投影）。双写失败只打日志，
// 永不抛错、不拦旧路径。
//
// 映射表：
//   group_norms(chat_id)         → predicate 'group.norm'
//   user_profiles(chat,uid)      → predicate 'person.interest'
//   person_identity(uid)         → predicate 'person.trait'
//   world_entities(id)           → predicate 'entity.status'
//   goals(id, active)            → predicate 'goal.state'
//
// source_row_id：group_norms/person_identity 用 chat_id/uid 取负
// （表主键不是自增 int，用负数域区分，避免与自增 id 碰撞）。
// 同 (source_table, source_row_id, predicate) → upsert 去重，
// 旧行更新只改 summary，不插新行、不重置 confidence。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { upsertBelief } from './beliefs/store.js';
import { env } from './env-shim.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

function dualWriteOn(): boolean {
  try {
    return env().CORE_DUAL_WRITE;
  } catch {
    return false;
  }
}

/** 双写入口总闸：关 → 零开销直接返回。 */
function gate(): boolean {
  return dualWriteOn();
}

function hasColumn(table: string, column: string): boolean {
  try {
    return (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((item) => item.name === column);
  } catch {
    return false;
  }
}

/** Parse a persisted scope key without falling back to a broader scope. */
function scopeFromWorldRow(row: {
  scope_key?: string | null;
  visibility?: string | null;
  source_chat_id?: number | null;
}): CognitiveScope | null {
  const key = row.scope_key?.trim();
  if (!key || key === 'global' || row.visibility === 'global') return { visibility: 'global' };
  const chat = key.match(/^chat:(-?\d+)$/);
  if (chat) return { visibility: 'chat', chatId: Number(chat[1]) };
  const user = key.match(/^user:(-?\d+)(?:@chat:(-?\d+))?$/);
  if (user) return {
    visibility: 'user',
    userId: Number(user[1]),
    ...(user[2] === undefined ? {} : { chatId: Number(user[2]) }),
  };
  const task = key.match(/^task:(.+?)(?:@chat:(-?\d+))?$/);
  if (task?.[1]?.trim()) return {
    visibility: 'task',
    taskId: task[1].trim(),
    ...(task[2] === undefined ? {} : { chatId: Number(task[2]) }),
  };
  // A scoped schema with an unparseable key is ambiguous; do not leak it as a
  // chat/global belief. Legacy rows are handled by the caller explicitly.
  if (row.scope_key !== undefined) return null;
  return row.source_chat_id ? { visibility: 'chat', chatId: row.source_chat_id } : { visibility: 'global' };
}

function safeUpsert(args: {
  sourceTable: string;
  sourceRowId: number;
  predicate: string;
  summary: string;
  evidence: string[];
  scope?: CognitiveScope;
}): void {
  if (!gate()) return;
  try {
    if (!args.summary || !args.summary.trim()) return;
    upsertBelief({
      sourceTable: args.sourceTable,
      sourceRowId: args.sourceRowId,
      predicate: args.predicate,
      summary: args.summary.slice(0, 200),
      evidence: args.evidence,
      scope: args.scope,
    });
  } catch (err) {
    logger.debug({ err, ...args, summary: undefined }, 'belief dual-write failed (non-critical)');
  }
}

/** group_norms 保存后调：norms 数组 → 一条 'group.norm' belief。 */
export function syncGroupNorms(chatId: number): void {
  if (!gate()) return;
  try {
    const row = getDb()
      .prepare('SELECT norms FROM group_norms WHERE chat_id = ?')
      .get(chatId) as { norms: string } | undefined;
    if (!row) return;
    let norms: string[] = [];
    try {
      norms = JSON.parse(row.norms) as string[];
    } catch {
      return;
    }
    if (!Array.isArray(norms) || norms.length === 0) return;
    safeUpsert({
      sourceTable: 'group_norms',
      sourceRowId: chatId, // 负数 chat_id，天然区分
      predicate: 'group.norm',
      summary: norms.slice(0, 5).join('；').slice(0, 200),
      evidence: [`norms:${chatId}`],
      scope: { visibility: 'chat', chatId },
    });
  } catch (err) {
    logger.debug({ err, chatId }, 'syncGroupNorms failed (non-critical)');
  }
}

/** user_profiles 画像刷新后调：profile_prompt → 'person.interest' belief。 */
export function syncUserProfile(chatId: number, uid: number): void {
  if (!gate()) return;
  try {
    const row = getDb()
      .prepare('SELECT profile_prompt FROM user_profiles WHERE chat_id = ? AND uid = ?')
      .get(chatId, uid) as { profile_prompt: string | null } | undefined;
    const prompt = row?.profile_prompt?.trim();
    if (!prompt) return;
    safeUpsert({
      sourceTable: 'user_profiles',
      // Keep the source uid stable, while the persisted scope key separates
      // the same person across chats.
      sourceRowId: uid,
      predicate: 'person.interest',
      summary: prompt.slice(0, 200),
      evidence: [`profile:${chatId}:${uid}`],
      scope: { visibility: 'user', chatId, userId: uid },
    });
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'syncUserProfile failed (non-critical)');
  }
}

/** person_identity 刷新后调：impression → 'person.trait' belief。 */
export function syncPersonIdentity(uid: number): void {
  if (!gate()) return;
  try {
    const row = getDb()
      .prepare('SELECT impression FROM person_identity WHERE uid = ?')
      .get(uid) as { impression: string | null } | undefined;
    const imp = row?.impression?.trim();
    if (!imp) return;
    safeUpsert({
      sourceTable: 'person_identity',
      sourceRowId: uid,
      predicate: 'person.trait',
      summary: imp.slice(0, 200),
      evidence: [`identity:${uid}`],
      scope: { visibility: 'user', userId: uid },
    });
  } catch (err) {
    logger.debug({ err, uid }, 'syncPersonIdentity failed (non-critical)');
  }
}

/** world_entities upsert 后调：name+properties → 'entity.status' belief。 */
export function syncWorldEntity(entityId: number): void {
  if (!gate()) return;
  try {
    const scopedSchema = hasColumn('world_entities', 'scope_key');
    const row = getDb()
      .prepare(scopedSchema
        ? 'SELECT name, kind, source_chat_id, scope_key, visibility FROM world_entities WHERE id = ?'
        : 'SELECT name, kind, source_chat_id FROM world_entities WHERE id = ?')
      .get(entityId) as {
        name: string;
        kind: string;
        source_chat_id: number | null;
        scope_key?: string | null;
        visibility?: string | null;
      } | undefined;
    if (!row) return;
    const scope = scopeFromWorldRow(row);
    if (!scope) {
      logger.debug({ entityId, scopeKey: row.scope_key }, 'syncWorldEntity skipped ambiguous scope');
      return;
    }
    safeUpsert({
      sourceTable: 'world_entities',
      sourceRowId: entityId,
      predicate: 'entity.status',
      summary: `${row.name}（${row.kind}）`,
      evidence: [`entity:${entityId}`],
      scope,
    });
  } catch (err) {
    logger.debug({ err, entityId }, 'syncWorldEntity failed (non-critical)');
  }
}

/** goals 写入后调：active 目标 → 'goal.state' belief。 */
export function syncGoal(goalId: number): void {
  if (!gate()) return;
  try {
    const row = getDb()
      .prepare('SELECT topic, status, chat_id FROM goals WHERE id = ?')
      .get(goalId) as { topic: string; status: string; chat_id: number | null } | undefined;
    if (!row || row.status !== 'active') return;
    safeUpsert({
      sourceTable: 'goals',
      sourceRowId: goalId,
      predicate: 'goal.state',
      summary: row.topic.slice(0, 200),
      evidence: [`goal:${goalId}`],
      scope: row.chat_id ? { visibility: 'chat', chatId: row.chat_id } : { visibility: 'global' },
    });
  } catch (err) {
    logger.debug({ err, goalId }, 'syncGoal failed (non-critical)');
  }
}
