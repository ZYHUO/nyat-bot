// ────────────────────────────────────────
// reply_max quota — SQLite-based per-user per-day counter (max 3/day)
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';

const MAX_PER_DAY = 3;

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

export function getRemainingMaxQuota(uid: number): number {
  const row = getDb().prepare(
    'SELECT count FROM reply_max_quota WHERE uid = ? AND date = ?',
  ).get(uid, today()) as { count: number } | undefined;
  return Math.max(0, MAX_PER_DAY - (row?.count ?? 0));
}

export function consumeMaxQuota(uid: number): void {
  const d = today();
  getDb().prepare(`
    INSERT INTO reply_max_quota (uid, date, count) VALUES (?, ?, 1)
    ON CONFLICT(uid, date) DO UPDATE SET count = count + 1
  `).run(uid, d);
}
