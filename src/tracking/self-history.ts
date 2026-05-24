// ────────────────────────────────────────
// Stage F: Self-narrative — bot remembers what it said to each user
// ────────────────────────────────────────
//
// 目的：bot 不要前后矛盾。生成下一条 reply 前，查询"我最近对该 user 说过啥"，
//   注入 prompt 让模型保持一致。
//
// 数据：self_replies(id, chat_id, trigger_uid, trigger_msg_id, reply_text, ts)
//   - 每发一条 reply 就 INSERT 一条
//   - 查询：(chat_id, uid) 过滤 + ts 倒序 limit N，且 ts 在 windowDays 内
//   - cleanup: pruneOldSelfReplies(60) 删 60 天以上的
//
// 默认 SELF_HISTORY_ENABLED=false 时所有公开函数 no-op，保证零开销。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export interface SelfReply {
  ts: number;
  text: string;
}

/** Persist a single reply made by the bot. No-op when disabled. */
export function recordSelfReply(
  chatId: number,
  triggerUid: number,
  triggerMsgId: number | null,
  replyText: string,
): void {
  if (!env().SELF_HISTORY_ENABLED) return;
  const text = (replyText ?? '').trim();
  if (!text) return;
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO self_replies (chat_id, trigger_uid, trigger_msg_id, reply_text, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(chatId, triggerUid, triggerMsgId, text.slice(0, 500), Math.floor(Date.now() / 1000));
  } catch (err) {
    logger.debug({ err, chatId, triggerUid }, 'recordSelfReply failed (non-critical)');
  }
}

/**
 * Get up to `limit` recent self replies to a specific user within `withinDays` days.
 * Returns [] when disabled.
 */
export function getRecentSelfReplies(
  chatId: number,
  uid: number,
  limit = 5,
  withinDays = 30,
): SelfReply[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86400;
    const rows = db
      .prepare(
        `SELECT reply_text AS text, ts FROM self_replies
         WHERE chat_id = ? AND trigger_uid = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, uid, cutoff, limit) as { text: string; ts: number }[];
    return rows;
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'getRecentSelfReplies failed (non-critical)');
    return [];
  }
}

/**
 * Format recent self replies as a prompt section. Returns empty string when no entries
 * or feature off.
 */
export function selfHistoryPromptSection(replies: SelfReply[]): string {
  if (!replies || replies.length === 0) return '';
  const lines = replies.map((r) => {
    const dt = new Date(r.ts * 1000);
    const stamp = `${dt.getMonth() + 1}/${dt.getDate()}`;
    const text = r.text.length > 80 ? r.text.slice(0, 80) + '…' : r.text;
    return `- ${stamp}: ${text}`;
  });
  return `【你最近对 ta 说过的话】\n${lines.join('\n')}\n注意保持一致，避免前后矛盾。`;
}

/**
 * Delete self_replies entries older than `olderThanDays` days. Returns count deleted.
 * Safe to call with feature off (just no-op).
 */
export function pruneOldSelfReplies(olderThanDays = 60): number {
  if (!env().SELF_HISTORY_ENABLED) return 0;
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    const result = db.prepare('DELETE FROM self_replies WHERE ts < ?').run(cutoff);
    const deleted = Number(result.changes ?? 0);
    if (deleted > 0) {
      logger.info({ deleted, olderThanDays }, 'pruneOldSelfReplies completed');
    }
    return deleted;
  } catch (err) {
    logger.warn({ err }, 'pruneOldSelfReplies failed');
    return 0;
  }
}
