// ────────────────────────────────────────
// 功能 B2:攒话队列 — 对高好感用户「想说但没机会说」的话
// ────────────────────────────────────────
//
// 存意图(非成品文案),等对方私聊时由 generatePersonaProactiveText 自然说出。
// 三家定稿:flush 不一次性倾倒(取 1-2 条),其余留待后续;过期自动失效。

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);
const DEFAULT_TTL_SEC = 14 * 86400; // 14 天
const MAX_PER_USER = 5;

export interface DmPendingLine {
  intent: string;
  context: string;
}

/** 入队一条攒话(超 MAX_PER_USER 时滚除最老未 flush 的)。 */
export function enqueueDmPending(uid: number, intent: string, context = '', ttlSec = DEFAULT_TTL_SEC): void {
  if (!intent.trim()) return;
  try {
    const db = getDb();
    const t = nowSec();
    db.prepare(
      `INSERT INTO dm_pending_lines (uid, intent, context, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(uid, intent.slice(0, 200), context.slice(0, 300), t, t + ttlSec);
    // 滚除超额(只数未 flush 的)
    const live = db
      .prepare(`SELECT id FROM dm_pending_lines WHERE uid = ? AND flushed_at IS NULL ORDER BY created_at DESC`)
      .all(uid) as { id: number }[];
    if (live.length > MAX_PER_USER) {
      const drop = live.slice(MAX_PER_USER).map((r) => r.id);
      db.prepare(`DELETE FROM dm_pending_lines WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
    }
  } catch (err) {
    logger.debug({ err, uid }, 'enqueueDmPending failed (non-critical)');
  }
}

export function countDmPending(uid: number): number {
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM dm_pending_lines WHERE uid = ? AND flushed_at IS NULL AND expires_at > ?`)
      .get(uid, nowSec()) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** 取最多 max 条未 flush 未过期的攒话,并标记 flushed(渐进释放:默认 2 条)。 */
export function takeDmPending(uid: number, max = 2): DmPendingLine[] {
  try {
    const db = getDb();
    const t = nowSec();
    const rows = db
      .prepare(
        `SELECT id, intent, context FROM dm_pending_lines
           WHERE uid = ? AND flushed_at IS NULL AND expires_at > ?
           ORDER BY created_at ASC LIMIT ?`,
      )
      .all(uid, t, max) as { id: number; intent: string; context: string }[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    db.prepare(`UPDATE dm_pending_lines SET flushed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(t, ...ids);
    return rows.map((r) => ({ intent: r.intent, context: r.context }));
  } catch (err) {
    logger.debug({ err, uid }, 'takeDmPending failed (non-critical)');
    return [];
  }
}
