import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { LearnerScanResult, JargonEntry } from './types.js';

/**
 * Upsert jargon candidates into DB. Increments count and appends samples on conflict.
 */
export function upsertJargons(
  chatId: number,
  items: LearnerScanResult['jargons'],
  contextSnippet?: string,
): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const insertStmt = db.prepare(`
    INSERT INTO jargons (chat_id, content, raw_samples, count, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'pending', ?, ?)
    ON CONFLICT(chat_id, content) DO UPDATE SET
      count = count + 1,
      raw_samples = CASE
        WHEN json_array_length(jargons.raw_samples) < 10
        THEN json_insert(jargons.raw_samples, '$[#]', excluded.raw_samples)
        ELSE jargons.raw_samples
      END,
      updated_at = excluded.updated_at
  `);

  let inserted = 0;
  const run = db.transaction(() => {
    for (const item of items) {
      if (!item.content.trim()) continue;
      const sample = contextSnippet ? contextSnippet.slice(0, 200) : '';
      insertStmt.run(chatId, item.content.trim(), sample, now, now);
      inserted++;
    }
  });
  run();
  logger.debug({ chatId, inserted }, 'Upserted jargons');
  return inserted;
}

/**
 * Get jargons that have reached a threshold count but haven't been inferred yet at that level.
 */
export function getJargonsForInference(chatId: number, thresholds: number[]): JargonEntry[] {
  const db = getDb();
  if (thresholds.length === 0) return [];
  const minThreshold = Math.min(...thresholds);
  return db.prepare(
    `SELECT * FROM jargons WHERE chat_id = ? AND status = 'pending' AND count >= ? ORDER BY count DESC LIMIT 10`,
  ).all(chatId, minThreshold) as JargonEntry[];
}

/**
 * Mark a jargon as inferred with its meaning.
 */
export function markJargonInferred(chatId: number, content: string, meaning: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE jargons SET meaning = ?, status = 'inferred', updated_at = ? WHERE chat_id = ? AND content = ?`,
  ).run(meaning, now, chatId, content);
}

/**
 * Query a jargon by content in a specific chat.
 */
export function queryJargon(chatId: number, term: string): JargonEntry | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM jargons WHERE chat_id = ? AND content = ?',
  ).get(chatId, term) as JargonEntry | undefined;
}

/**
 * Fuzzy search jargons by content prefix.
 */
export function searchJargons(chatId: number, term: string): JargonEntry[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM jargons WHERE chat_id = ? AND content LIKE ? AND meaning != \'\' ORDER BY count DESC LIMIT 5',
  ).all(chatId, `%${term}%`) as JargonEntry[];
}
