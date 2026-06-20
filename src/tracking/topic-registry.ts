// ────────────────────────────────────────
// Topic lifecycle registry — 借鉴 CGM Recording Pipeline / Topic Registry
// ────────────────────────────────────────
//
// 每群一份「在聊什么」的话题表,带生命周期状态机:
//   active(在聊)──无活动 COOLING_SEC──▶ cooling(渐冷)──再无活动 DEAD_SEC──▶ dead(过去式)──PRUNE_SEC──▶ 删除
// 再次被观察到 → 任何状态都拉回 active(话题重新被提起)。
//
// 这个文件是**确定性**部分(纯 SQLite,可测);话题标签的抽取(LLM)在 topic-scan.ts。

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const COOLING_SEC = 20 * 60;   // active → cooling:20 分钟没再聊
const DEAD_SEC = 90 * 60;      // cooling → dead:再 90 分钟没动静(总计)
const PRUNE_SEC = 24 * 3600;   // dead 超过一天 → 删除
const MAX_LIVE_PER_CHAT = 6;   // 每群最多保留的 live(active+cooling)话题数

export type TopicState = 'active' | 'cooling' | 'dead';

export interface TopicRow {
  id: number;
  chat_id: number;
  label: string;
  state: TopicState;
  msg_count: number;
  first_seen: number;
  last_active: number;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').slice(0, 40);
}

/**
 * Observe a topic in a chat: create it, or bump+reactivate an existing one.
 * Re-mentioning a cooling/dead topic pulls it back to active (话题重新被提起).
 */
export function observeTopic(chatId: number, rawLabel: string, now = Math.floor(Date.now() / 1000)): void {
  const label = normalizeLabel(rawLabel);
  if (!label) return;
  try {
    getDb().prepare(
      `INSERT INTO chat_topics (chat_id, label, state, msg_count, first_seen, last_active)
       VALUES (?, ?, 'active', 1, ?, ?)
       ON CONFLICT(chat_id, label) DO UPDATE SET
         state = 'active',
         msg_count = msg_count + 1,
         last_active = excluded.last_active`,
    ).run(chatId, label, now, now);
  } catch (err) {
    logger.debug({ err, chatId }, 'observeTopic failed (non-critical)');
  }
}

/** Advance the lifecycle state machine for a chat + prune old dead topics. */
export function tickLifecycle(chatId: number, now = Math.floor(Date.now() / 1000)): void {
  try {
    const db = getDb();
    db.prepare(`UPDATE chat_topics SET state='cooling' WHERE chat_id=? AND state='active'  AND last_active < ?`).run(chatId, now - COOLING_SEC);
    db.prepare(`UPDATE chat_topics SET state='dead'    WHERE chat_id=? AND state='cooling' AND last_active < ?`).run(chatId, now - DEAD_SEC);
    db.prepare(`DELETE FROM chat_topics WHERE chat_id=? AND state='dead' AND last_active < ?`).run(chatId, now - PRUNE_SEC);
    // 防爆:每群 live 话题超过上限时,把最旧的降级为 dead(只保留最近活跃的)
    const live = db.prepare(`SELECT id FROM chat_topics WHERE chat_id=? AND state IN ('active','cooling') ORDER BY last_active DESC`).all(chatId) as Array<{ id: number }>;
    if (live.length > MAX_LIVE_PER_CHAT) {
      const stale = live.slice(MAX_LIVE_PER_CHAT).map((r) => r.id);
      db.prepare(`UPDATE chat_topics SET state='dead' WHERE id IN (${stale.map(() => '?').join(',')})`).run(...stale);
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'tickLifecycle failed (non-critical)');
  }
}

/** Live topics (active + cooling), newest first. */
export function getActiveTopics(chatId: number, limit = MAX_LIVE_PER_CHAT): TopicRow[] {
  try {
    return getDb().prepare(
      `SELECT * FROM chat_topics WHERE chat_id=? AND state IN ('active','cooling') ORDER BY last_active DESC LIMIT ?`,
    ).all(chatId, limit) as TopicRow[];
  } catch {
    return [];
  }
}

/** A compact prompt line describing what the chat is currently about (or null). */
export function getTopicLine(chatId: number): string | null {
  const topics = getActiveTopics(chatId, 4);
  if (topics.length === 0) return null;
  const parts = topics.map((t) => (t.state === 'cooling' ? `${t.label}(渐冷)` : t.label));
  return `群里最近在聊:${parts.join('、')}`;
}
