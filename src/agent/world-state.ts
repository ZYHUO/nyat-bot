// ────────────────────────────────────────
// World State — 轻量对象中心世界状态 (AGI Level 5 Phase 6)
//
// 面向对象世界模型(文本版,YAGNI 不做视觉/物理): 把任务/聊天中出现的
// 实体(person/project/topic/place)持续 upsert, goal check 开工前注入
// 相关实体属性 → 「持续关注」有上下文基础。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface WorldEntity {
  id: number;
  name: string;
  kind: string;
  properties: Record<string, string>;
  sourceChatId: number | null;
  lastUpdatedAt: number;
  createdAt: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** upsert 一个实体(按 name+kind 去重,合并属性)。 */
export function upsertEntity(
  name: string,
  kind: 'person' | 'project' | 'topic' | 'place',
  properties: Record<string, string>,
  sourceChatId?: number | null,
): number | null {
  const nm = name.trim().slice(0, 100);
  if (!nm) return null;
  try {
    const db = getDb();
    const ts = nowSec();
    const existing = db.prepare('SELECT id, properties FROM world_entities WHERE name = ? AND kind = ?').get(nm, kind) as
      | { id: number; properties: string }
      | undefined;
    const merged: Record<string, string> = { ...(existing ? JSON.parse(existing.properties) : {}), ...properties };
    const propsJson = JSON.stringify(merged).slice(0, 2000);
    if (existing) {
      db.prepare(`UPDATE world_entities SET properties = ?, source_chat_id = COALESCE(?, source_chat_id), last_updated_at = ? WHERE id = ?`).run(
        propsJson,
        sourceChatId ?? null,
        ts,
        existing.id,
      );
      return existing.id;
    }
    const r = db
      .prepare(
        `INSERT INTO world_entities (name, kind, properties, source_chat_id, last_updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nm, kind, propsJson, sourceChatId ?? null, ts, ts);
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err, name: nm, kind }, 'upsertEntity failed');
    return null;
  }
}

/** 按名称/类型查询实体。 */
export function findEntities(query: string, kind?: string, limit = 4): WorldEntity[] {
  try {
    const db = getDb();
    const like = `%${query.trim().slice(0, 50)}%`;
    const rows = kind
      ? (db.prepare(`SELECT * FROM world_entities WHERE kind = ? AND name LIKE ? ORDER BY last_updated_at DESC LIMIT ?`).all(kind, like, limit) as unknown[])
      : (db.prepare(`SELECT * FROM world_entities WHERE name LIKE ? ORDER BY last_updated_at DESC LIMIT ?`).all(like, limit) as unknown[]);
    return rows.map(parseRow);
  } catch (err) {
    logger.warn({ err }, 'findEntities failed');
    return [];
  }
}

/** 全部实体(供注入)。 */
export function listAllEntities(limit = 10): WorldEntity[] {
  try {
    const rows = getDb()
      .prepare(`SELECT * FROM world_entities ORDER BY last_updated_at DESC, id DESC LIMIT ?`)
      .all(limit) as unknown[];
    return rows.map(parseRow);
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
  };
}

/** 构建注入 prompt 的 [世界状态] 块(按查询匹配相关实体)。 */
export function buildWorldStateBlock(query: string, limit = 4): string {
  const entities = findEntities(query, undefined, limit);
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
