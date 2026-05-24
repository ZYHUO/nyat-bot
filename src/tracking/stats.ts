import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const msgCounts = new Map<string, Map<number, number>>(); // chatId -> uid -> count
const botReplyCounts = new Map<number, number>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordMessage(chatId: number, uid: number): void {
  const key = `${chatId}:${today()}`;
  let users = msgCounts.get(key);
  if (!users) { users = new Map(); msgCounts.set(key, users); }
  users.set(uid, (users.get(uid) ?? 0) + 1);
}

export function recordBotReply(chatId: number): void {
  const key = chatId;
  botReplyCounts.set(key, (botReplyCounts.get(key) ?? 0) + 1);
}

export function flushDailyStats(): void {
  const db = getDb();
  const date = today();
  const stmt = db.prepare(`
    INSERT INTO daily_stats (chat_id, date, total_messages, active_users, bot_replies, top_users)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, date) DO UPDATE SET
      total_messages = total_messages + excluded.total_messages,
      active_users = MAX(active_users, excluded.active_users),
      bot_replies = bot_replies + excluded.bot_replies,
      top_users = excluded.top_users
  `);

  for (const [key, users] of msgCounts) {
    const [chatIdStr] = key.split(':');
    const chatId = Number(chatIdStr);
    const total = [...users.values()].reduce((a, b) => a + b, 0);
    const topUsers = [...users.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([uid, count]) => ({ uid, count }));
    const botReplies = botReplyCounts.get(chatId) ?? 0;
    stmt.run(chatId, date, total, users.size, botReplies, JSON.stringify(topUsers));
  }

  msgCounts.clear();
  botReplyCounts.clear();
  logger.debug('Daily stats flushed');
}

export function getStats(chatId: number, days = 7): Array<{
  date: string; total_messages: number; active_users: number; bot_replies: number; top_users: Array<{ uid: number; count: number }>;
}> {
  const rows = getDb().prepare(
    'SELECT * FROM daily_stats WHERE chat_id = ? ORDER BY date DESC LIMIT ?',
  ).all(chatId, days) as Array<{
    date: string; total_messages: number; active_users: number; bot_replies: number; top_users: string;
  }>;
  return rows.map((r) => ({ ...r, top_users: JSON.parse(r.top_users) }));
}
