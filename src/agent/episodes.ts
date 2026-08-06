// ────────────────────────────────────────
// Episodic Store + Experience Entries — 经验沉淀 (AGI Level 4 P4-A)
//
// CodeAct 任务终态后复盘：一段「情节」(episode) 记录目标/结果/教训，
// 蒸馏出的可复用经验 (experience_entries) 按 FTS + tag 检索。
// 下次开工前 findRelevantExperience(contentDirection) 注入 executor prompt
// —— 犯过的错不再犯第二遍。长期不用的经验按 use_count 自然沉底淘汰。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface EpisodeInput {
  taskId: string;
  chatId: number;
  goal: string;
  outcome: 'done' | 'failed';
  summary: string;
  lessons: string[];
  tags: string[];
  turns: number;
  segments: number;
}

export interface ExperienceEntryInput {
  kind: string; // pitfall | trick | preference
  content: string;
  tags: string[];
  sourceEpisodeId: number;
}

export interface ExperienceHit {
  content: string;
  kind: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeJsonArray(v: unknown): string {
  try {
    return JSON.stringify(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : []);
  } catch {
    return '[]';
  }
}

/** 保存一段任务情节。返回 rowid，失败返回 null（复盘不该炸主流程）。 */
export function saveEpisode(e: EpisodeInput): number | null {
  try {
    const r = getDb()
      .prepare(
        `INSERT INTO episodes (task_id, chat_id, goal, outcome, summary, lessons, tags, turns, segments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.taskId,
        e.chatId,
        e.goal.slice(0, 500),
        e.outcome,
        e.summary.slice(0, 2000),
        safeJsonArray(e.lessons),
        safeJsonArray(e.tags),
        e.turns | 0,
        e.segments | 0,
        nowSec(),
      );
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err, taskId: e.taskId }, 'saveEpisode failed');
    return null;
  }
}

/** 保存蒸馏出的经验条目。 */
export function saveExperienceEntries(entries: ExperienceEntryInput[]): void {
  if (!entries.length) return;
  try {
    const stmt = getDb().prepare(
      `INSERT INTO experience_entries (kind, content, tags, source_episode_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const ts = nowSec();
    for (const en of entries.slice(0, 8)) {
      if (!en.content?.trim()) continue;
      stmt.run(String(en.kind || 'trick').slice(0, 32), en.content.trim().slice(0, 500), safeJsonArray(en.tags), en.sourceEpisodeId, ts);
    }
  } catch (err) {
    logger.warn({ err }, 'saveExperienceEntries failed');
  }
}

/**
 * 按查询文本检索相关经验（FTS）。命中即 use_count++ / last_used_at 更新。
 * 查询做安全转义：非法 FTS 语法（引号、特殊符）回退为 token OR 查询，再不行返回空。
 */
export function findRelevantExperience(query: string, limit = 3): ExperienceHit[] {
  try {
    const db = getDb();
    const tokens = query
      .replace(/["'*():^]/g, ' ')
      .split(/[\s，。、,.!?;；/\\-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 6);
    if (!tokens.length) return [];
    const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');
    const rows = db
      .prepare(
        `SELECT e.id, e.content, e.kind FROM experience_fts f
         JOIN experience_entries e ON e.id = f.rowid
         WHERE experience_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit * 3) as { id: number; content: string; kind: string }[];
    if (!rows.length) return [];
    // 优先低使用次数的（新经验优先曝光），截到 limit
    rows.sort((a, b) => a.id - b.id);
    const picked = rows.slice(0, limit);
    const bump = db.prepare(`UPDATE experience_entries SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`);
    const ts = nowSec();
    for (const r of picked) bump.run(ts, r.id);
    return picked.map((r) => ({ content: r.content, kind: r.kind }));
  } catch (err) {
    logger.debug({ err }, 'findRelevantExperience failed (non-fatal)');
    return [];
  }
}

/** 经验库上限淘汰：超出 maxEntries 时按 use_count 升序（少用的先删），同分按创建时间。 */
export function pruneExperience(maxEntries = 200): void {
  try {
    const db = getDb();
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM experience_entries`).get() as { c: number };
    if (c <= maxEntries) return;
    const excess = c - maxEntries;
    db.prepare(
      `DELETE FROM experience_entries WHERE id IN (
         SELECT id FROM experience_entries ORDER BY use_count ASC, created_at ASC LIMIT ?
       )`,
    ).run(excess);
  } catch (err) {
    logger.warn({ err }, 'pruneExperience failed');
  }
}
