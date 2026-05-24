import { getDb } from '../db/sqlite.js';

const LEVELS: Array<[number, string]> = [
  [10000, 'diamond'], [2000, 'platinum'], [500, 'gold'], [100, 'silver'], [0, 'bronze'],
];

const LEVEL_NAMES: Record<string, string> = {
  bronze: '🥉 青铜', silver: '🥈 白银', gold: '🥇 黄金', platinum: '💎 铂金', diamond: '👑 钻石',
};

export function resolveLevel(points: number): string {
  for (const [threshold, level] of LEVELS) {
    if (points >= threshold) return level;
  }
  return 'bronze';
}

export function addPoints(chatId: number, uid: number, delta: number, reason: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_reputation (chat_id, uid, points, level, updated_at)
    VALUES (?, ?, MAX(0, ?), ?, unixepoch())
    ON CONFLICT(chat_id, uid) DO UPDATE SET
      points = MAX(0, points + ?),
      level = ?,
      updated_at = unixepoch()
  `).run(chatId, uid, delta, resolveLevel(delta), delta, resolveLevel(
    ((db.prepare('SELECT points FROM user_reputation WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { points: number } | undefined)?.points ?? 0) + delta
  ));
  db.prepare('INSERT INTO reputation_log (chat_id, uid, delta, reason) VALUES (?, ?, ?, ?)').run(chatId, uid, delta, reason);
}

export function getReputation(chatId: number, uid: number): { points: number; level: string; levelName: string } {
  const row = getDb().prepare('SELECT points, level FROM user_reputation WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { points: number; level: string } | undefined;
  const points = row?.points ?? 0;
  const level = row?.level ?? 'bronze';
  return { points, level, levelName: LEVEL_NAMES[level] ?? level };
}

export function getLeaderboard(chatId: number, limit = 10): Array<{ uid: number; points: number; level: string }> {
  return getDb().prepare(
    'SELECT uid, points, level FROM user_reputation WHERE chat_id = ? ORDER BY points DESC LIMIT ?',
  ).all(chatId, limit) as Array<{ uid: number; points: number; level: string }>;
}

// Daily message points cap tracking (in-memory, resets on restart)
const dailyMsgPoints = new Map<string, number>();

export function tryAddMessagePoints(chatId: number, uid: number): void {
  const today = new Date().toISOString().slice(0, 10);
  // Lazy cleanup: remove stale entries from previous days
  for (const k of dailyMsgPoints.keys()) {
    if (!k.endsWith(today)) dailyMsgPoints.delete(k);
  }
  const key = `${chatId}:${uid}:${today}`;
  const current = dailyMsgPoints.get(key) ?? 0;
  if (current >= 5) return;
  dailyMsgPoints.set(key, current + 1);
  addPoints(chatId, uid, 1, 'message');
}
