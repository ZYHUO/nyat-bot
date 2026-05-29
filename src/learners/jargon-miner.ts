import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { LearnerScanResult, JargonEntry } from './types.js';

/**
 * Inference threshold tiers. A jargon is (re-)inferred each time its count
 * crosses the next tier beyond the count at which it was last inferred. Higher
 * tiers re-run inference with more samples to refine the previously stored
 * meaning, instead of re-inferring repeatedly at the same tier.
 */
export const JARGON_INFERENCE_THRESHOLDS = [4, 8, 25, 100]; // tunable

/**
 * The highest tier in `thresholds` that `count` has reached, or 0 if none.
 */
function highestCrossedThreshold(count: number, thresholds: number[]): number {
  let crossed = 0;
  for (const t of thresholds) {
    if (count >= t && t > crossed) crossed = t;
  }
  return crossed;
}

/** JargonEntry as stored, including the inference-tier bookkeeping column. */
type JargonRow = JargonEntry & { last_inference_count: number };

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
 * Get jargons whose count has crossed the NEXT inference tier beyond the count
 * at which they were last inferred (`last_inference_count`). This avoids
 * re-inferring the same jargon repeatedly at the same tier: a jargon is only
 * returned once it climbs into a higher threshold band, at which point the
 * inference is re-run to refine the previously stored meaning.
 *
 * If no `thresholds` are supplied the module-level tiers are used.
 */
export function getJargonsForInference(
  chatId: number,
  thresholds: number[] = JARGON_INFERENCE_THRESHOLDS,
): JargonEntry[] {
  const db = getDb();
  const tiers = thresholds.filter((t) => t > 0).sort((a, b) => a - b);
  if (tiers.length === 0) return [];
  const minThreshold = tiers[0]!;

  // 'confirmed' jargons are manually locked and never re-inferred. We do allow
  // already-'inferred' jargons back through, so higher tiers can refine them.
  const rows = db.prepare(
    `SELECT * FROM jargons
       WHERE chat_id = ? AND status != 'confirmed' AND count >= ?
       ORDER BY count DESC LIMIT 30`,
  ).all(chatId, minThreshold) as JargonRow[];

  return rows.filter(
    (r) => highestCrossedThreshold(r.count, tiers) > (r.last_inference_count ?? 0),
  );
}

/**
 * Mark a jargon as inferred with its meaning. Also records the count at which
 * inference ran (`last_inference_count`) so the next tier-crossing — not the
 * same tier — is what re-triggers inference.
 */
export function markJargonInferred(chatId: number, content: string, meaning: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE jargons
       SET meaning = ?, status = 'inferred', last_inference_count = count, updated_at = ?
       WHERE chat_id = ? AND content = ?`,
  ).run(meaning, now, chatId, content);
}

/**
 * Inference produced no usable meaning at this tier. Advance
 * `last_inference_count` to the current count so we don't keep retrying at the
 * same tier, but leave any existing meaning and status untouched.
 */
export function markJargonNoInfo(chatId: number, content: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE jargons
       SET last_inference_count = count, updated_at = ?
       WHERE chat_id = ? AND content = ?`,
  ).run(now, chatId, content);
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
