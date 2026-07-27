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
/** 永久档在重要度上的乘数(protection = 2)。 */
export const PERMANENT_BOOST = 2;

/**
 * 保护档(migration 0052)。对齐 MaiBot v1.1.0 的「冻结/恢复/保护/永久保留」。
 *
 * 存在的理由:遗忘条件是 `ref_count = 0 AND 超龄`,而人设级核心事实(生日、称呼、
 * 雷区、约定)恰恰属于"很少被检索命中、但一旦忘了就很致命"的那类 —— 它们会和
 * 普通闲聊一起被删掉。
 */
export const PROTECTION = { NONE: 0, PROTECTED: 1, PERMANENT: 2 } as const;
export type ProtectionLevel = (typeof PROTECTION)[keyof typeof PROTECTION];

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

/**
 * importance ∈ (0, ∞): base 1 × recency-decay × (1 + boost·log1p(refs)) × protection。Pure。
 *
 * ⚠️ 注意:本函数目前**没有任何生产调用方** —— 遗忘走的是 getForgettableIds 里
 * 那条粗糙的 `ref_count = 0 AND 超龄`,检索排序也没用上它。保留并扩展它是因为
 * 「按重要度遗忘」比「只删从没被召回过的」更贴近 MaiBot 的自然衰减语义,但切换
 * 遗忘口径是行为变更,应当单独一次改动 + 灰度,不在本次范围内。
 */
export function importanceScore(
  createdAt: number,
  refCount: number,
  now = Math.floor(Date.now() / 1000),
  protection: number = PROTECTION.NONE,
): number {
  const ageDays = Math.max(0, (now - createdAt) / 86400);
  const recency = Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
  const base = recency * (1 + REFERENCE_BOOST * Math.log1p(refCount));
  return protection >= PROTECTION.PERMANENT ? base * PERMANENT_BOOST : base;
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
    // protection > 0 一律排除。**无条件生效,不挂 flag** —— 一个"默认关"的保护开关
    // 等于没有保护:忘掉的记忆找不回来,而这里的失败是不可逆的。
    // 存量行由 migration 的 DEFAULT 0 覆盖,所以对现有数据行为不变。
    const rows = getDb().prepare(
      'SELECT chroma_id FROM memory_meta WHERE chat_id = ? AND protection = 0 AND ref_count = 0 AND created_at < ? ORDER BY created_at ASC LIMIT ?',
    ).all(chatId, cutoff, limit) as Array<{ chroma_id: string }>;
    return rows.map((r) => r.chroma_id);
  } catch (err) {
    log.debug({ err, chatId }, 'getForgettableIds failed');
    return [];
  }
}

/**
 * 设置保护档。返回实际更新的行数(id 不存在时为 0)。
 * 显式操作 —— 没有做"引用够多次就自动晋升":遗忘条件本就已排除 ref_count > 0,
 * 那种自动晋升在当前口径下是个空操作,加了只会让人误以为有一层保护。
 */
export function setProtection(chromaIds: string[], level: ProtectionLevel): number {
  if (chromaIds.length === 0) return 0;
  try {
    const stmt = getDb().prepare('UPDATE memory_meta SET protection = ? WHERE chroma_id = ?');
    let n = 0;
    const tx = getDb().transaction((ids: string[]) => {
      for (const id of ids) n += stmt.run(level, id).changes;
    });
    tx(chromaIds);
    log.info({ count: n, level }, 'memory protection updated');
    return n;
  } catch (err) {
    log.warn({ err, level }, 'setProtection failed');
    return 0;
  }
}

/** 读保护档;未知 id 视作 NONE。 */
export function getProtection(chromaIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (chromaIds.length === 0) return out;
  try {
    const placeholders = chromaIds.map(() => '?').join(',');
    const rows = getDb().prepare(
      `SELECT chroma_id, protection FROM memory_meta WHERE chroma_id IN (${placeholders})`,
    ).all(...chromaIds) as Array<{ chroma_id: string; protection: number }>;
    for (const r of rows) out.set(r.chroma_id, r.protection);
  } catch { /* non-critical */ }
  return out;
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
