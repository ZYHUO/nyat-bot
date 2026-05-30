// ────────────────────────────────────────
// Memory importance + forgetting (auto-dream port)
//
// Tracks per-Chroma-entry metadata so memory can be scored and pruned:
//   importance = base × recency × reference_boost
// - recency: exponential decay over age (older → less important)
// - reference_boost: memories actually recalled into replies matter more
// The "dream" cron forgets old, never-recalled memories (keeps Chroma lean and
// retrieval less noisy); retrieval can boost oft-recalled memories' ranking.
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const RECENCY_HALFLIFE_DAYS = 14;     // tunable — importance recency half-life
export const REFERENCE_BOOST = 0.25;  // tunable — weight of recall frequency

const log = logger.child({ mod: 'memory-importance' });

/** Record that a memory entry was just created (called from memorizeMessage). */
export function recordMemoryCreated(chromaId: string, chatId: number, createdAt = Math.floor(Date.now() / 1000)): void {
  try {
    getDb().prepare(
      'INSERT OR IGNORE INTO memory_meta (chroma_id, chat_id, created_at, ref_count) VALUES (?, ?, ?, 0)',
    ).run(chromaId, chatId, createdAt);
  } catch (err) {
    log.debug({ err, chromaId }, 'recordMemoryCreated failed (non-critical)');
  }
}

/** Record that memories were actually recalled into a reply (bumps ref_count + recency). */
export function recordMemoryReferenced(chromaIds: string[]): void {
  if (chromaIds.length === 0) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = getDb().prepare(
      'UPDATE memory_meta SET ref_count = ref_count + 1, last_ref_at = ? WHERE chroma_id = ?',
    );
    const tx = getDb().transaction((ids: string[]) => { for (const id of ids) stmt.run(now, id); });
    tx(chromaIds);
  } catch (err) {
    log.debug({ err }, 'recordMemoryReferenced failed (non-critical)');
  }
}

/** importance ∈ (0, ∞): base 1 × recency-decay × (1 + boost·log1p(refs)). Pure. */
export function importanceScore(createdAt: number, refCount: number, now = Math.floor(Date.now() / 1000)): number {
  const ageDays = Math.max(0, (now - createdAt) / 86400);
  const recency = Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
  return recency * (1 + REFERENCE_BOOST * Math.log1p(refCount));
}

/** Per-id reference counts (for retrieval ranking boosts). */
export function getRefCounts(chromaIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (chromaIds.length === 0) return out;
  try {
    const placeholders = chromaIds.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT chroma_id, ref_count FROM memory_meta WHERE chroma_id IN (${placeholders})`,
    ).all(...chromaIds) as Array<{ chroma_id: string; ref_count: number }>;
    for (const r of rows) out.set(r.chroma_id, r.ref_count);
  } catch { /* non-critical */ }
  return out;
}

/**
 * Find forgettable memory ids for a chat: older than minAgeDays AND never recalled
 * (ref_count = 0). Returns up to `limit` oldest-first.
 */
export function getForgettableIds(chatId: number, minAgeDays: number, limit: number): string[] {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - minAgeDays * 86400;
    const rows = getDb().prepare(
      'SELECT chroma_id FROM memory_meta WHERE chat_id = ? AND ref_count = 0 AND created_at < ? ORDER BY created_at ASC LIMIT ?',
    ).all(chatId, cutoff, limit) as Array<{ chroma_id: string }>;
    return rows.map((r) => r.chroma_id);
  } catch (err) {
    log.debug({ err, chatId }, 'getForgettableIds failed');
    return [];
  }
}

/** Delete sidecar rows after their Chroma entries are pruned. */
export function deleteMeta(chromaIds: string[]): void {
  if (chromaIds.length === 0) return;
  try {
    const stmt = getDb().prepare('DELETE FROM memory_meta WHERE chroma_id = ?');
    const tx = getDb().transaction((ids: string[]) => { for (const id of ids) stmt.run(id); });
    tx(chromaIds);
  } catch { /* non-critical */ }
}

/** Distinct chats with memory metadata (for the dream cron to iterate). */
export function chatsWithMemory(): number[] {
  try {
    const rows = getDb().prepare('SELECT DISTINCT chat_id FROM memory_meta').all() as Array<{ chat_id: number }>;
    return rows.map((r) => r.chat_id);
  } catch {
    return [];
  }
}
