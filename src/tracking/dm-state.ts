// ────────────────────────────────────────
// 功能 B:DM 状态 — dm_ever(是否私聊过)+ pm_nudge 催促状态机
// ────────────────────────────────────────
//
// TG 硬限制:bot 只能给「曾给 bot 发过消息」的人主动发 DM。dm_users 记录谁私聊过,
// 是「能否主动 DM」的唯一依据。pm_nudge_state 是「高好感但从没 DM → 群里@催pm」
// 的状态机(默认关灰度,见 cron/pm-nudge.ts)。全部 fail-soft(出错返回安全默认)。

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

// ── pm_nudge 状态机 ──────────────────────────────────────

export type PmState = 'none' | 'nudging' | 'dm_open' | 'exhausted';

export interface PmNudge {
  uid: number;
  state: PmState;
  attempts: number;
  lastNudgeAt: number | null;
  nextNudgeAt: number | null;
  primaryChatId: number | null;
  resentment: number;
  exhaustedUntil: number | null;
}

const DEFAULT_NUDGE = (uid: number): PmNudge => ({
  uid, state: 'none', attempts: 0, lastNudgeAt: null, nextNudgeAt: null,
  primaryChatId: null, resentment: 0, exhaustedUntil: null,
});

export function getPmNudge(uid: number): PmNudge {
  try {
    const row = getDb()
      .prepare(
        `SELECT uid, state, attempts, last_nudge_at, next_nudge_at, primary_chat_id, resentment, exhausted_until
           FROM pm_nudge_state WHERE uid = ?`,
      )
      .get(uid) as
      | { uid: number; state: string; attempts: number; last_nudge_at: number | null; next_nudge_at: number | null; primary_chat_id: number | null; resentment: number; exhausted_until: number | null }
      | undefined;
    if (!row) return DEFAULT_NUDGE(uid);
    return {
      uid: row.uid, state: row.state as PmState, attempts: row.attempts,
      lastNudgeAt: row.last_nudge_at, nextNudgeAt: row.next_nudge_at,
      primaryChatId: row.primary_chat_id, resentment: row.resentment, exhaustedUntil: row.exhausted_until,
    };
  } catch (err) {
    logger.debug({ err, uid }, 'getPmNudge failed (non-critical)');
    return DEFAULT_NUDGE(uid);
  }
}

export function upsertPmNudge(uid: number, patch: Partial<Omit<PmNudge, 'uid'>>): void {
  try {
    const cur = getPmNudge(uid);
    const next = { ...cur, ...patch };
    getDb()
      .prepare(
        `INSERT INTO pm_nudge_state (uid, state, attempts, last_nudge_at, next_nudge_at, primary_chat_id, resentment, exhausted_until, updated_at)
         VALUES (@uid, @state, @attempts, @lastNudgeAt, @nextNudgeAt, @primaryChatId, @resentment, @exhaustedUntil, @now)
         ON CONFLICT(uid) DO UPDATE SET
           state=excluded.state, attempts=excluded.attempts, last_nudge_at=excluded.last_nudge_at,
           next_nudge_at=excluded.next_nudge_at, primary_chat_id=excluded.primary_chat_id,
           resentment=excluded.resentment, exhausted_until=excluded.exhausted_until, updated_at=excluded.updated_at`,
      )
      .run({ ...next, now: nowSec() });
  } catch (err) {
    logger.debug({ err, uid }, 'upsertPmNudge failed (non-critical)');
  }
}

/** 用户私聊了 → 催促停摆,转 dm_open(清零次数/怨气)。 */
export function markPmDmOpen(uid: number): void {
  const cur = getPmNudge(uid);
  if (cur.state === 'dm_open') return;
  upsertPmNudge(uid, { state: 'dm_open', attempts: 0, nextNudgeAt: null, resentment: 0, exhaustedUntil: null });
}
