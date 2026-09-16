// ────────────────────────────────────────
// 功能 B:DM 状态 — dm_ever(是否私聊过)
// ────────────────────────────────────────
//
// TG 硬限制:bot 只能给「曾给 bot 发过消息」的人主动发 DM。dm_users 记录谁私聊过,
// 是「能否主动 DM」的唯一依据。全部 fail-soft(出错返回安全默认)。
// (原 pm_nudge 催促状态机已随 pm-nudge 功能于 2026-08-04 删除。)

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

// ── dm_ever ──────────────────────────────────────────────

/** 标记用户私聊过 bot(幂等,刷新 last_dm_at)。 */
export function markDmEver(uid: number): void {
  try {
    const t = nowSec();
    getDb()
      .prepare(
        `INSERT INTO dm_users (uid, first_dm_at, last_dm_at) VALUES (?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET last_dm_at = excluded.last_dm_at`,
      )
      .run(uid, t, t);
  } catch (err) {
    logger.debug({ err, uid }, 'markDmEver failed (non-critical)');
  }
}

export function hasDmEver(uid: number): boolean {
  try {
    return !!getDb().prepare(`SELECT 1 FROM dm_users WHERE uid = ?`).get(uid);
  } catch {
    return false;
  }
}

/** 近 maxAgeSec 内私聊过的用户(供睡前/起床 DM 扫描;0=不限) */
export function listDmEverUids(maxAgeSec = 0): number[] {
  try {
    const db = getDb();
    const rows = maxAgeSec > 0
      ? (db.prepare(`SELECT uid FROM dm_users WHERE last_dm_at >= ?`).all(nowSec() - maxAgeSec) as { uid: number }[])
      : (db.prepare(`SELECT uid FROM dm_users`).all() as { uid: number }[]);
    return rows.map((r) => r.uid);
  } catch {
    return [];
  }
}
