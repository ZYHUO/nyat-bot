// ────────────────────────────────────────
// 功能 B0:跨群好感聚合(per-uid 读模型)
// ────────────────────────────────────────
//
// relationship.ts 是 per-(chatId,uid) 的事实源(继续保留、不动)。这里在其之上
// 做 per-uid 聚合读模型,供"高好感→更爱聊 / 主动 DM / @催pm"判定用。
//
// 三家评审定稿:**绝不简单累加**(否则多群活跃的人轻松破百、谁都像恋人)。
// 用 0.6×最高群 + 0.4×(按 sqrt(互动数) 加权的均值),再 clamp [-100,100]:
//   - 最高群项:有一个群很亲近就够("这人是熟人")。
//   - 加权均值项:奖励"到处都还不错"的一致性,但 sqrt 压制刷群。
// 读时对每群 affinity 施加与 relationship.ts 一致的时间衰减(只读,不回写)。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { decayValence } from './mood.js';
import { affinityBucket, type RelBucket } from './relationship.js';

// 与 relationship.ts 的读时衰减保持一致(~两周减半)
const RELATIONSHIP_DECAY_RATE = 0.002;

const AFFINITY_MIN = -100;
const AFFINITY_MAX = 100;

export interface AggregatedAffinity {
  /** 聚合好感,clamp [-100,100] */
  affinity: number;
  bucket: RelBucket;
  /** 跨群互动总次数 */
  interactionTotal: number;
  /** 该 uid 出现的群数 */
  chatCount: number;
  /** 互动最多的群(供 @催pm 选群);无则 null */
  primaryChatId: number | null;
}

const EMPTY: AggregatedAffinity = {
  affinity: 0,
  bucket: '一般',
  interactionTotal: 0,
  chatCount: 0,
  primaryChatId: null,
};

interface RelRow {
  chat_id: number;
  affinity: number;
  interaction_count: number;
  last_interaction_at: number;
}

/**
 * uid 的跨群聚合好感。RELATIONSHIP_ENABLED 关时返回零值。
 * 纯读:对每群 affinity 施加时间衰减后聚合,不回写。
 */
export function getAggregatedAffinity(uid: number): AggregatedAffinity {
  if (!env().RELATIONSHIP_ENABLED) return EMPTY;
  try {
    const rows = getDb()
      .prepare(
        `SELECT chat_id, affinity, interaction_count, last_interaction_at
           FROM chat_relationships WHERE uid = ?`,
      )
      .all(uid) as RelRow[];
    if (rows.length === 0) return EMPTY;

    const now = Math.floor(Date.now() / 1000);
    let maxDecayed = -Infinity;
    let weightedSum = 0;
    let weightTotal = 0;
    let interactionTotal = 0;
    let primaryChatId: number | null = null;
    let primaryCount = -1;

    for (const r of rows) {
      const hours = Math.max(0, (now - r.last_interaction_at) / 3600);
      const decayed = decayValence(r.affinity, hours, RELATIONSHIP_DECAY_RATE);
      const weight = Math.sqrt(Math.max(1, r.interaction_count)); // sqrt 压制刷群
      maxDecayed = Math.max(maxDecayed, decayed);
      weightedSum += decayed * weight;
      weightTotal += weight;
      interactionTotal += r.interaction_count;
      if (r.interaction_count > primaryCount) {
        primaryCount = r.interaction_count;
        primaryChatId = r.chat_id;
      }
    }

    const weightedMean = weightTotal > 0 ? weightedSum / weightTotal : 0;
    let agg = 0.6 * maxDecayed + 0.4 * weightedMean;
    agg = Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, agg));

    return {
      affinity: agg,
      bucket: affinityBucket(agg),
      interactionTotal,
      chatCount: rows.length,
      primaryChatId,
    };
  } catch (err) {
    logger.debug({ err, uid }, 'getAggregatedAffinity failed (non-critical)');
    return EMPTY;
  }
}
