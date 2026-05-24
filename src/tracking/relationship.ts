// ────────────────────────────────────────
// Stage F: Relationship narrative — per (chatId, uid) affinity tracking
// ────────────────────────────────────────
//
// 目的：bot 跟老朋友和陌生人说话感觉应当不一样。
//   每对 (chatId, uid) 维护：
//     - affinity ∈ [-100, 100]: 累计正负反馈
//     - interaction_count: 互动次数
//     - last_summary: LLM 概括 (留接口给 cron 后期实现)
//
// affinity 调整事件 (在 outcome.ts 触发):
//   - positive outcome (用户回复 bot / @bot 称谢): +1
//   - negative outcome (被 ignore): -0.5 (轻微，避免过度惩罚)
//   - 直接 mute: 由 pipeline.ts 触发更大的惩罚 (-3 ~ -8)
//
// bucket 划分: |affinity| < threshold (default 20) 不注入 prompt。
//
// 默认 RELATIONSHIP_ENABLED=false 时全部 no-op。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export type RelBucket = '亲近' | '熟人' | '一般' | '反感';

export interface RelState {
  affinity: number;
  count: number;
  bucket: RelBucket;
  lastSummary: string;
}

const AFFINITY_MIN = -100;
const AFFINITY_MAX = 100;

export function affinityBucket(affinity: number): RelBucket {
  if (affinity >= 30) return '亲近';
  if (affinity >= 10) return '熟人';
  if (affinity >= -10) return '一般';
  return '反感';
}

function clampAffinity(v: number): number {
  if (v > AFFINITY_MAX) return AFFINITY_MAX;
  if (v < AFFINITY_MIN) return AFFINITY_MIN;
  return v;
}

/** Read relationship state. Returns default-zero when disabled or unknown. */
export function getRelationship(chatId: number, uid: number): RelState {
  if (!env().RELATIONSHIP_ENABLED) {
    return { affinity: 0, count: 0, bucket: '一般', lastSummary: '' };
  }
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT affinity, interaction_count, last_summary
         FROM chat_relationships WHERE chat_id = ? AND uid = ?`,
      )
      .get(chatId, uid) as
      | { affinity: number; interaction_count: number; last_summary: string }
      | undefined;
    if (!row) {
      return { affinity: 0, count: 0, bucket: '一般', lastSummary: '' };
    }
    return {
      affinity: row.affinity,
      count: row.interaction_count,
      bucket: affinityBucket(row.affinity),
      lastSummary: row.last_summary ?? '',
    };
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'getRelationship failed (non-critical)');
    return { affinity: 0, count: 0, bucket: '一般', lastSummary: '' };
  }
}

/**
 * Apply an event delta. Reads existing, adds delta, clamps, increments interaction_count.
 * Optional summary updates last_summary.
 */
export function applyRelationshipEvent(
  chatId: number,
  uid: number,
  delta: number,
  summary?: string,
): void {
  if (!env().RELATIONSHIP_ENABLED) return;
  if (!Number.isFinite(delta)) return;
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = db
      .prepare(
        'SELECT affinity, interaction_count FROM chat_relationships WHERE chat_id = ? AND uid = ?',
      )
      .get(chatId, uid) as
      | { affinity: number; interaction_count: number }
      | undefined;

    const nextAffinity = clampAffinity((existing?.affinity ?? 0) + delta);
    const nextCount = (existing?.interaction_count ?? 0) + 1;
    const nextSummary = summary && summary.trim() ? summary.slice(0, 200) : (existing ? undefined : '');

    if (existing) {
      // Use COALESCE to keep prior summary unless new summary provided
      db.prepare(
        `UPDATE chat_relationships
         SET affinity = ?, interaction_count = ?, last_interaction_at = ?, updated_at = ?
         ${nextSummary !== undefined ? ', last_summary = ?' : ''}
         WHERE chat_id = ? AND uid = ?`,
      ).run(
        ...(nextSummary !== undefined
          ? [nextAffinity, nextCount, now, now, nextSummary, chatId, uid]
          : [nextAffinity, nextCount, now, now, chatId, uid]),
      );
    } else {
      db.prepare(
        `INSERT INTO chat_relationships
         (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(chatId, uid, nextAffinity, nextCount, now, nextSummary ?? '', now);
    }

    logger.debug(
      { chatId, uid, delta, affinity: nextAffinity, count: nextCount },
      'Relationship event applied',
    );
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'applyRelationshipEvent failed (non-critical)');
  }
}

/**
 * Generate a prompt-injectable hint. Returns '' when |affinity| < threshold or feature off.
 * Threshold prevents noise from neutral relationships dominating the prompt.
 */
export function relationshipPromptHint(state: RelState): string {
  if (!env().RELATIONSHIP_ENABLED) return '';
  const threshold = env().RELATIONSHIP_INJECT_THRESHOLD;
  if (Math.abs(state.affinity) < threshold) return '';

  const countNote =
    state.count >= 50 ? '老朋友'
    : state.count >= 10 ? '聊过不少次'
    : '互动过几次';

  switch (state.bucket) {
    case '亲近':
      return `【与该用户关系】${countNote}，关系亲近。你跟 ta 说话可以更随意、更亲昵一点，能开稍重一点的玩笑。`;
    case '熟人':
      return `【与该用户关系】${countNote}，算熟人。说话比对陌生人放松一些。`;
    case '反感':
      return `【与该用户关系】${countNote}，对 ta 印象偏差。说话偏冷淡偏短，不要主动接梗，但也不要主动挑衅。`;
    case '一般':
    default:
      return '';
  }
}
