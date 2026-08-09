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
import { decayValence } from './mood.js';

// Per-hour exponential decay applied to stored affinity on read (read-side only,
// never written back). magnitude *= (1 - rate)^hoursSinceLastInteraction.
// 0.002/hr ⇒ ~half-life ~14.4 天 (ln(0.5)/ln(0.998) ≈ 346h)，即两周左右减半。
const RELATIONSHIP_DECAY_RATE = 0.002; // per-hour, tunable — ~halves in ~2 weeks

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
        `SELECT affinity, interaction_count, last_interaction_at, last_summary
         FROM chat_relationships WHERE chat_id = ? AND uid = ?`,
      )
      .get(chatId, uid) as
      | {
          affinity: number;
          interaction_count: number;
          last_interaction_at: number;
          last_summary: string;
        }
      | undefined;
    if (!row) {
      return { affinity: 0, count: 0, bucket: '一般', lastSummary: '' };
    }
    // Apply time-decay toward 0 on read. last_interaction_at is unix seconds.
    // Decayed value is NOT persisted — fresh interactions re-anchor via applyRelationshipEvent.
    const now = Math.floor(Date.now() / 1000);
    const hoursElapsed = Math.max(0, (now - row.last_interaction_at) / 3600);
    const decayed = decayValence(row.affinity, hoursElapsed, RELATIONSHIP_DECAY_RATE);
    return {
      affinity: decayed,
      count: row.interaction_count,
      bucket: affinityBucket(decayed),
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

    // Opus 评审: 好感慢升快降 —— 正 delta 缩水(需要很多次正交互才涨),
    // 负 delta 放大(一次伤害掉很多)。env 门控, 默认关(行为与旧版一致)。
    const asymEnabled = env().RELATIONSHIP_ASYMMETRY_ENABLED;
    const scaledDelta = asymEnabled
      ? delta * (delta > 0 ? env().RELATIONSHIP_ASYMMETRY_UP : env().RELATIONSHIP_ASYMMETRY_DOWN)
      : delta;
    const nextAffinity = clampAffinity((existing?.affinity ?? 0) + scaledDelta);
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
      return `[关系] 和这位是${countNote},关系亲近:说话可以更随意更亲昵,开得起稍重的玩笑。`;
    case '熟人':
      return `[关系] 和这位${countNote},算熟人:比对陌生人放松一些。`;
    case '反感':
      return `[关系] 和这位${countNote},但印象偏差:话偏冷偏短,不主动接梗,也不主动挑衅。`;
    case '一般':
    default:
      return '';
  }
}

/**
 * #8 生人/熟人不对称:互动 ≤2 次的发送者注入"陌生人,矜持点"提示。
 * 此前新人拿不到任何提示,跟 50+ 次互动的老熟人一个亲昵调。
 */
export function newcomerPromptHint(count: number): string | null {
  if (count <= 2) {
    return '[关系] 这位群友你们几乎没说过话(近乎陌生人):语气客气一点,别自来熟、别上昵称、别贴贴。';
  }
  return null;
}
