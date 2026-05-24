import { getDb } from '../db/sqlite.js';

export function addWatch(chatId: number, uid: number, keywords: string, expiresInSec?: number): boolean {
  const db = getDb();
  const kw = keywords.toLowerCase();
  if (kw.length < 2 || kw.length > 50) return false;
  // Per-user-per-group limit
  const count = (db.prepare('SELECT COUNT(*) as c FROM topic_watches WHERE chat_id = ? AND uid = ?').get(chatId, uid) as { c: number }).c;
  if (count >= 20) return false;
  const expiresAt = expiresInSec ? Math.floor(Date.now() / 1000) + expiresInSec : null;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO topic_watches (chat_id, uid, keywords, expires_at) VALUES (?, ?, ?, ?)',
    ).run(chatId, uid, kw, expiresAt);
    return true;
  } catch { return false; }
}

export function removeWatch(chatId: number, uid: number, keywords: string): boolean {
  return getDb().prepare(
    'DELETE FROM topic_watches WHERE chat_id = ? AND uid = ? AND keywords = ?',
  ).run(chatId, uid, keywords.toLowerCase()).changes > 0;
}

export function listWatches(chatId: number, uid: number): string[] {
  const rows = getDb().prepare(
    'SELECT keywords FROM topic_watches WHERE chat_id = ? AND uid = ? AND (expires_at IS NULL OR expires_at > unixepoch())',
  ).all(chatId, uid) as Array<{ keywords: string }>;
  return rows.map((r) => r.keywords);
}

export function checkWatches(chatId: number, text: string, senderUid: number): number[] {
  const lower = text.toLowerCase();
  const rows = getDb().prepare(
    'SELECT DISTINCT uid, keywords FROM topic_watches WHERE chat_id = ? AND (expires_at IS NULL OR expires_at > unixepoch())',
  ).all(chatId) as Array<{ uid: number; keywords: string }>;
  const matched = new Set<number>();
  for (const r of rows) {
    if (r.uid === senderUid) continue; // don't notify self
    if (lower.includes(r.keywords)) matched.add(r.uid);
  }
  return [...matched];
}

export function cleanExpired(): number {
  return getDb().prepare('DELETE FROM topic_watches WHERE expires_at IS NOT NULL AND expires_at < unixepoch()').run().changes;
}
