// ────────────────────────────────────────
// World State — 轻量对象中心世界状态 (AGI Level 5 Phase 6)
//
// 面向对象世界模型(文本版,YAGNI 不做视觉/物理): 把任务/聊天中出现的
// 实体(person/project/topic/place)持续 upsert, goal check 开工前注入
// 相关实体属性 → 「持续关注」有上下文基础。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { scopeKey, scopeKeysForPredicate } from '../shared/cognitive-scope.js';
import type { CognitiveScope, ScopeVisibility } from '../shared/cognitive-scope.js';

export interface WorldEntity {
  id: number;
  name: string;
  kind: string;
  properties: Record<string, string>;
  sourceChatId: number | null;
  lastUpdatedAt: number;
  createdAt: number;
  scopeKey?: string;
  visibility?: ScopeVisibility;
  currentRevision?: number;
  sourceEventId?: string | null;
  confidence?: number;
  expiresAt?: number | null;
}

export interface WorldEntityRevision {
  id: number;
  entityId: number;
  revision: number;
  scopeKey: string;
  sourceEventId: string | null;
  properties: Record<string, string>;
  confidence: number;
  status: 'active' | 'stale' | 'contradicted' | 'superseded' | 'expired';
  supersededBy: number | null;
  createdAt: number;
  expiresAt: number | null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasColumn(db: ReturnType<typeof getDb>, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>).some((item) => item.name === column);
}

function hasTable(db: ReturnType<typeof getDb>, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function appendRevision(
  db: ReturnType<typeof getDb>,
  entityId: number,
  entityScopeKey: string,
  properties: Record<string, string>,
  input: { sourceEventId?: string; confidence?: number; expiresAt?: number },
): boolean {
  if (!hasTable(db, 'world_entity_revisions') || !hasColumn(db, 'world_entities', 'current_revision')) return false;
  const sourceEventId = input.sourceEventId?.trim().slice(0, 240) || null;
  if (sourceEventId) {
    const existing = db.prepare(
      'SELECT id FROM world_entity_revisions WHERE entity_id = ? AND source_event_id = ? LIMIT 1',
    ).get(entityId, sourceEventId) as { id?: number } | undefined;
    if (existing?.id) return false;
  }
  const revision = db
    .prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM world_entity_revisions WHERE entity_id = ?')
    .get(entityId) as { next: number };
  const confidence = Math.min(1, Math.max(0, Number.isFinite(input.confidence) ? input.confidence! : 0.5));
  const expiresAt = input.expiresAt !== undefined && Number.isSafeInteger(input.expiresAt) ? input.expiresAt : null;
  const createdAt = nowSec();
  const inserted = db
    .prepare(
      `INSERT INTO world_entity_revisions
         (entity_id, revision, scope_key, source_event_id, properties_json, confidence, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(entityId, revision.next, entityScopeKey, sourceEventId, JSON.stringify(properties).slice(0, 2000), confidence, createdAt, expiresAt);
  const revisionId = Number(inserted.lastInsertRowid);
  db.prepare(
    `UPDATE world_entity_revisions SET status = 'superseded', superseded_by = ?
     WHERE entity_id = ? AND id != ? AND status = 'active'`,
  ).run(revisionId, entityId, revisionId);
  db.prepare(
    `UPDATE world_entities SET current_revision = ?, source_event_id = ?, confidence = ?, expires_at = ? WHERE id = ?`,
  ).run(revision.next, sourceEventId, confidence, expiresAt, entityId);
  return true;
}

/** upsert 一个实体(按 name+kind 去重,合并属性)。 */
/**
 * Reject names that are not entity-like.
 *
 * A world entity is a short, stable noun phrase ("Rust", "显示器选购", "@awei").
 * Reply *instructions* ("@x 用 reply+@ 点了你上一句 #80208… 禁止空问候…") are not
 * world facts. On 2026-09-18 the table was found to contain 2,711 rows that were
 * ALL instructions, because callers passed `contentDirection` straight through —
 * and those rows were rendered into the live prompt as "[相关世界实体]".
 *
 * Validating here (rather than at each call site) means no future caller can
 * reintroduce the pollution.
 */
function isEntityLikeName(name: string): boolean {
  // Length is a weak signal on its own: measured against the 2,710 polluted rows
  // from the 2026-09-18 backup, the shape rules below reject 100% of them at
  // every limit from 40 to 80, while a real group title
  // ("Uzumaru公群 | 音游交流群版 🔥东南亚上押1920U…", 41 chars) needs headroom.
  // So keep the cap generous and let shape do the discriminating.
  if (name.length < 2 || name.length > 80) return false;
  if (/[\n\r#]/.test(name)) return false;
  // Imperative / instructional phrasing that only appears in reply directives.
  if (/(禁止|必须|不要|请|回气泡|复读|空问候|接话|回应|短回|自然|语气)/.test(name)) return false;
  // A quoted message body means this is a task description, not a name.
  if (/「|」/.test(name)) return false;
  // Sentence-shaped: real entity names do not contain clause punctuation or
  // second-person/verb-final instructions like "…再回".
  if (/[，。；、！？,;!?]/.test(name)) return false;
  if (/(再回|再说|再答|先看|先弄清|然后|接着)/.test(name)) return false;
  return true;
}

export function upsertEntity(
  name: string,
  kind: 'person' | 'project' | 'topic' | 'place',
  properties: Record<string, string>,
  sourceChatId?: number | null,
  scope?: CognitiveScope,
  provenance?: { sourceEventId?: string; confidence?: number; expiresAt?: number },
): number | null {
  const nm = name.trim().slice(0, 100);
  if (!nm) return null;
  if (!isEntityLikeName(nm)) {
    logger.debug({ name: nm.slice(0, 60), kind }, 'world-state: rejected non-entity name');
    return null;
  }
  try {
    const db = getDb();
    const ts = nowSec();
    const scopedSchema = hasColumn(db, 'world_entities', 'scope_key');
    const effectiveScope = scope ?? (sourceChatId ? { visibility: 'chat', chatId: sourceChatId } : { visibility: 'global' });
    const entityScopeKey = scopeKey(effectiveScope);
    const existing = (scopedSchema
      ? db.prepare('SELECT id, properties FROM world_entities WHERE name = ? AND kind = ? AND scope_key = ?').get(nm, kind, entityScopeKey)
      : db.prepare('SELECT id, properties FROM world_entities WHERE name = ? AND kind = ?').get(nm, kind)) as
      | { id: number; properties: string }
      | undefined;
    const merged: Record<string, string> = { ...(existing ? JSON.parse(existing.properties) : {}), ...properties };
    const propsJson = JSON.stringify(merged).slice(0, 2000);
    if (existing) {
      if (scopedSchema) {
        db.prepare(
          `UPDATE world_entities SET properties = ?, source_chat_id = COALESCE(?, source_chat_id),
             scope_key = ?, visibility = ?, last_updated_at = ? WHERE id = ?`,
        ).run(propsJson, sourceChatId ?? effectiveScope.chatId ?? null, entityScopeKey, effectiveScope.visibility, ts, existing.id);
      } else {
        db.prepare(`UPDATE world_entities SET properties = ?, source_chat_id = COALESCE(?, source_chat_id), last_updated_at = ? WHERE id = ?`).run(
          propsJson,
          sourceChatId ?? null,
          ts,
          existing.id,
        );
      }
      appendRevision(db, existing.id, entityScopeKey, merged, provenance ?? {});
      // Phase 2 双写：同步 belief（fire-and-forget）
      const eid = existing.id;
      void import('../core/migrate.js')
        .then(({ syncWorldEntity }) => syncWorldEntity(eid))
        .catch(() => { /* non-critical */ });
      return existing.id;
    }
    const r = scopedSchema
      ? db
          .prepare(
            `INSERT INTO world_entities
               (name, kind, properties, source_chat_id, last_updated_at, created_at, scope_key, visibility)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(nm, kind, propsJson, sourceChatId ?? effectiveScope.chatId ?? null, ts, ts, entityScopeKey, effectiveScope.visibility)
      : db
          .prepare(
            `INSERT INTO world_entities (name, kind, properties, source_chat_id, last_updated_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(nm, kind, propsJson, sourceChatId ?? null, ts, ts);
    const newId = Number(r.lastInsertRowid);
    appendRevision(db, newId, entityScopeKey, properties, provenance ?? {});
    // Phase 2 双写：同步 belief（fire-and-forget）
    void import('../core/migrate.js')
      .then(({ syncWorldEntity }) => syncWorldEntity(newId))
      .catch(() => { /* non-critical */ });
    return newId;
  } catch (err) {
    logger.warn({ err, name: nm, kind }, 'upsertEntity failed');
    return null;
  }
}

function parseRevisionRow(row: Record<string, unknown>): WorldEntityRevision {
  let properties: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(row['properties_json'] ?? '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      properties = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'));
    }
  } catch {
    properties = {};
  }
  return {
    id: Number(row['id']),
    entityId: Number(row['entity_id']),
    revision: Number(row['revision']),
    scopeKey: String(row['scope_key']),
    sourceEventId: row['source_event_id'] === null ? null : String(row['source_event_id']),
    properties,
    confidence: Number(row['confidence']),
    status: row['status'] as WorldEntityRevision['status'],
    supersededBy: row['superseded_by'] === null ? null : Number(row['superseded_by']),
    createdAt: Number(row['created_at']),
    expiresAt: row['expires_at'] === null ? null : Number(row['expires_at']),
  };
}

/** List immutable world revisions; never returns another scope's history. */
export function listEntityRevisions(entityId: number, limit = 20, scope?: CognitiveScope): WorldEntityRevision[] {
  try {
    const db = getDb();
    if (!hasTable(db, 'world_entity_revisions')) return [];
    const take = Math.min(Math.max(Math.trunc(limit), 1), 100);
    if (scope) {
      return (db.prepare(
        `SELECT * FROM world_entity_revisions WHERE entity_id = ? AND scope_key = ?
         ORDER BY revision DESC LIMIT ?`,
      ).all(entityId, scopeKey(scope), take) as Record<string, unknown>[]).map(parseRevisionRow);
    }
    return (db.prepare('SELECT * FROM world_entity_revisions WHERE entity_id = ? ORDER BY revision DESC LIMIT ?').all(entityId, take) as Record<string, unknown>[]).map(parseRevisionRow);
  } catch (err) {
    logger.debug({ err, entityId }, 'listEntityRevisions failed');
    return [];
  }
}

/** 按名称/类型查询实体。 */
export function findEntities(
  query: string,
  kind?: string,
  limit = 4,
  scope?: CognitiveScope,
  options: { asOf?: number } = {},
): WorldEntity[] {
  try {
    const db = getDb();
    const like = `%${query.trim().slice(0, 50)}%`;
    const asOf = Number.isSafeInteger(options.asOf) && (options.asOf as number) > 0 ? options.asOf : undefined;
    // Historical reads overfetch current rows because a recently updated row
    // may need reconstruction from the append-only revision table.
    const queryLimit = asOf === undefined ? limit : Math.min(200, Math.max(limit, Math.trunc(limit) * 4));
    const scopedSchema = hasColumn(db, 'world_entities', 'scope_key');
    let rows: unknown[];
    if (scope) {
      const keys = scopeKeysForPredicate('entity.status', scope);
      if (!keys.length) return [];
      if (scopedSchema) {
        const placeholders = keys.map(() => '?').join(', ');
        rows = kind
          ? (db.prepare(`SELECT * FROM world_entities WHERE kind = ? AND name LIKE ? AND scope_key IN (${placeholders}) ORDER BY last_updated_at DESC LIMIT ?`).all(kind, like, ...keys, queryLimit) as unknown[])
          : (db.prepare(`SELECT * FROM world_entities WHERE name LIKE ? AND scope_key IN (${placeholders}) ORDER BY last_updated_at DESC LIMIT ?`).all(like, ...keys, queryLimit) as unknown[]);
      } else {
        rows = kind
          ? (db.prepare(`SELECT * FROM world_entities WHERE kind = ? AND name LIKE ? ORDER BY last_updated_at DESC LIMIT ?`).all(kind, like, queryLimit) as unknown[])
          : (db.prepare(`SELECT * FROM world_entities WHERE name LIKE ? ORDER BY last_updated_at DESC LIMIT ?`).all(like, queryLimit) as unknown[]);
        const chatId = scope.chatId;
        if (chatId !== undefined) {
          rows = rows.filter((row) => {
            const source = (row as Record<string, unknown>)['source_chat_id'];
            return source === null || Number(source) === chatId;
          });
        }
      }
    } else {
      rows = kind
        ? (db.prepare(`SELECT * FROM world_entities WHERE kind = ? AND name LIKE ? ORDER BY last_updated_at DESC LIMIT ?`).all(kind, like, queryLimit) as unknown[])
        : (db.prepare(`SELECT * FROM world_entities WHERE name LIKE ? ORDER BY last_updated_at DESC LIMIT ?`).all(like, queryLimit) as unknown[]);
    }
    const ts = asOf ?? nowSec();
    const liveRows = hasColumn(db, 'world_entities', 'expires_at')
      ? rows.filter((row) => {
          const expiresAt = (row as Record<string, unknown>)['expires_at'];
          return expiresAt === null || expiresAt === undefined || Number(expiresAt) > ts;
        })
      : rows;
    return liveRows.map(parseRow);
  } catch (err) {
    logger.warn({ err }, 'findEntities failed');
    return [];
  }
}

/** 全部实体(供注入)。 */
export function listAllEntities(limit = 10, scope?: CognitiveScope): WorldEntity[] {
  try {
    const db = getDb();
    const scopedSchema = hasColumn(db, 'world_entities', 'scope_key');
    let rows: unknown[];
    if (scope && scopedSchema) {
      const keys = scopeKeysForPredicate('entity.status', scope);
      if (!keys.length) return [];
      const placeholders = keys.map(() => '?').join(', ');
      rows = db.prepare(`SELECT * FROM world_entities WHERE scope_key IN (${placeholders}) ORDER BY last_updated_at DESC, id DESC LIMIT ?`).all(...keys, limit) as unknown[];
    } else {
      rows = db.prepare(`SELECT * FROM world_entities ORDER BY last_updated_at DESC, id DESC LIMIT ?`).all(limit) as unknown[];
      if (scope?.chatId !== undefined && !scopedSchema) {
        rows = rows.filter((row) => {
          const source = (row as Record<string, unknown>)['source_chat_id'];
          return source === null || Number(source) === scope.chatId;
        });
      }
    }
    const ts = nowSec();
    const liveRows = hasColumn(db, 'world_entities', 'expires_at')
      ? rows.filter((row) => {
          const expiresAt = (row as Record<string, unknown>)['expires_at'];
          return expiresAt === null || expiresAt === undefined || Number(expiresAt) > ts;
        })
      : rows;
    return liveRows.map(parseRow);
  } catch (err) {
    logger.warn({ err }, 'listAllEntities failed');
    return [];
  }
}

function parseRow(r: unknown): WorldEntity {
  const o = r as Record<string, unknown>;
  let props: Record<string, string> = {};
  try {
    props = JSON.parse(String(o['properties'] ?? '{}'));
  } catch {
    props = {};
  }
  return {
    id: Number(o['id']),
    name: String(o['name']),
    kind: String(o['kind']),
    properties: props,
    sourceChatId: o['source_chat_id'] === null ? null : Number(o['source_chat_id']),
    lastUpdatedAt: Number(o['last_updated_at']),
    createdAt: Number(o['created_at']),
    ...(typeof o['scope_key'] === 'string' ? { scopeKey: o['scope_key'] } : {}),
    ...(typeof o['visibility'] === 'string' ? { visibility: o['visibility'] as ScopeVisibility } : {}),
    ...(o['current_revision'] !== undefined ? { currentRevision: Number(o['current_revision']) } : {}),
    ...(o['source_event_id'] !== undefined ? { sourceEventId: o['source_event_id'] === null ? null : String(o['source_event_id']) } : {}),
    ...(o['confidence'] !== undefined ? { confidence: Number(o['confidence']) } : {}),
    ...(o['expires_at'] !== undefined ? { expiresAt: o['expires_at'] === null ? null : Number(o['expires_at']) } : {}),
  };
}

/** 构建注入 prompt 的 [世界状态] 块(按查询匹配相关实体)。 */
export function buildWorldStateBlock(query: string, limit = 4, scope?: CognitiveScope): string {
  const entities = findEntities(query, undefined, limit, scope);
  if (!entities.length) return '';
  const lines = entities
    .map((e) => {
      const props = Object.entries(e.properties)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      return `- ${e.kind}「${e.name}」: ${props || '(无属性)'}`;
    })
    .join('\n');
  return `\n\n[世界状态]\n${lines}\n以上是已知的实体状态,以最新聊天为准,过时信息忽略。`;
}
