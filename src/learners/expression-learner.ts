import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { LearnerScanResult, ExpressionEntry } from './types.js';

/**
 * Parse LLM output into expressions and jargons.
 * Handles JSON wrapped in markdown code fences.
 */
export function parseLearnerOutput(raw: string): LearnerScanResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return { expressions: [], jargons: [] };

  let arr: unknown[];
  try {
    arr = JSON.parse(match[0]) as unknown[];
  } catch {
    return { expressions: [], jargons: [] };
  }

  const expressions: LearnerScanResult['expressions'] = [];
  const jargons: LearnerScanResult['jargons'] = [];

  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj['situation'] === 'string' && typeof obj['style'] === 'string') {
      expressions.push({
        situation: obj['situation'].slice(0, 60),
        style: obj['style'].slice(0, 60),
        source_id: typeof obj['source_id'] === 'string' ? obj['source_id'] : undefined,
      });
    } else if (typeof obj['content'] === 'string' && obj['content'].length >= 2) {
      jargons.push({
        content: obj['content'].slice(0, 30),
        source_id: typeof obj['source_id'] === 'string' ? obj['source_id'] : undefined,
      });
    }
  }
  return { expressions, jargons };
}

/**
 * Upsert expressions into DB. Increments count on conflict.
 */
export function upsertExpressions(
  chatId: number,
  items: LearnerScanResult['expressions'],
  sourceMsgId?: number,
): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO expressions (chat_id, situation, style, source_msg_id, count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(chat_id, situation, style) DO UPDATE SET
      count = count + 1,
      updated_at = excluded.updated_at
  `);

  let inserted = 0;
  const run = db.transaction(() => {
    for (const item of items) {
      if (!item.situation.trim() || !item.style.trim()) continue;
      const msgId = item.source_id ? Number(item.source_id) || sourceMsgId : sourceMsgId;
      stmt.run(chatId, item.situation.trim(), item.style.trim(), msgId ?? null, now, now);
      inserted++;
    }
  });
  run();
  logger.debug({ chatId, inserted }, 'Upserted expressions');
  return inserted;
}

/**
 * Get top expressions for a chat by count.
 */
export function getTopExpressions(chatId: number, limit: number): ExpressionEntry[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM expressions WHERE chat_id = ? ORDER BY count DESC LIMIT ?',
  ).all(chatId, limit) as ExpressionEntry[];
}
