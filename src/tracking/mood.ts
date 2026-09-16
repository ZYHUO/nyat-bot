// ────────────────────────────────────────
// Stage E: Chat mood drift
// 每个 chat 维护 valence ∈ [-100, 100]，随交互事件起伏，按时间指数衰减
// ────────────────────────────────────────
//
// 设计：
//   - valence 单维度评分。正向事件加分，负向减分，时间向 0 衰减
//   - bucket 是可读分档（cheerful/good/calm/down/grumpy）
//   - 读取时实时应用 decay：valence *= (1 - decay_rate * hours_since_last)
//     近似 exponential decay；decay_rate ∈ [0, 1] 表示每小时衰减比例
//   - 写入时先 decay 再加 delta，最后 clamp 到 [-100, 100]
//   - moodPromptHint 在 |valence| < 阈值时返回空串（calm 不影响 prompt）
//
// 集成位点：
//   - pipeline.ts mute 事件 → applyMoodEvent
//   - outcome.ts checkOutcome 事件 → applyMoodEvent
//   - prompt-builder.ts style 层 → moodPromptHint
//
// 默认开关 MOOD_ENABLED=false 时所有公开函数 no-op。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export type MoodBucket = 'cheerful' | 'good' | 'calm' | 'down' | 'grumpy';

export interface MoodState {
  valence: number;
  bucket: MoodBucket;
  lastEventSummary: string;
}

const VALENCE_MIN = -100;
const VALENCE_MAX = 100;

/** Convert valence to bucket label. Boundaries inclusive on lower side. */
export function valenceBucket(valence: number): MoodBucket {
  if (valence >= 60) return 'cheerful';
  if (valence >= 20) return 'good';
  if (valence >= -20) return 'calm';
  if (valence >= -60) return 'down';
  return 'grumpy';
}

function clampValence(v: number): number {
  if (v > VALENCE_MAX) return VALENCE_MAX;
  if (v < VALENCE_MIN) return VALENCE_MIN;
  return v;
}

/**
 * Apply exponential decay toward 0. decayRate is per-hour proportion (0..1).
 * For elapsed hours h, post-decay = pre * (1 - decayRate)^h.
 * decayRate=0.3 means after 1 hour 70% of magnitude remains, after 2 hours 49%, etc.
 */
export function decayValence(
  valence: number,
  hoursElapsed: number,
  decayRate: number,
): number {
  if (hoursElapsed <= 0 || decayRate <= 0) return valence;
  const factor = Math.pow(Math.max(0, 1 - decayRate), hoursElapsed);
  return valence * factor;
}

/**
 * Read current mood with decay applied. Default RUNNING state for unknown chats.
 * Returns calm/0 when MOOD_ENABLED=false (no DB read).
 */
export function getChatMood(chatId: number): MoodState {
  if (!env().MOOD_ENABLED) {
    return { valence: 0, bucket: 'calm', lastEventSummary: '' };
  }
  const db = getDb();
  const row = db
    .prepare(
      'SELECT valence, last_decay_at, last_event_summary FROM chat_mood WHERE chat_id = ?',
    )
    .get(chatId) as
    | { valence: number; last_decay_at: number; last_event_summary: string }
    | undefined;
  if (!row) {
    return { valence: 0, bucket: 'calm', lastEventSummary: '' };
  }
  const now = Math.floor(Date.now() / 1000);
  const hoursElapsed = Math.max(0, (now - row.last_decay_at) / 3600);
  const decayed = decayValence(
    row.valence,
    hoursElapsed,
    env().MOOD_DECAY_RATE_PER_HOUR,
  );
  return {
    valence: decayed,
    bucket: valenceBucket(decayed),
    lastEventSummary: row.last_event_summary ?? '',
  };
}

/**
 * Apply an event delta. Reads (with decay), adds delta, clamps, persists.
 * Updates last_event_at and last_decay_at to now.
 */
export function applyMoodEvent(
  chatId: number,
  delta: number,
  summary: string,
): void {
  if (!env().MOOD_ENABLED) return;
  if (!Number.isFinite(delta) || delta === 0) return;
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const e = env();
    const existing = db
      .prepare('SELECT valence, last_decay_at FROM chat_mood WHERE chat_id = ?')
      .get(chatId) as { valence: number; last_decay_at: number } | undefined;

    let nextValence: number;
    if (existing) {
      const hoursElapsed = Math.max(0, (now - existing.last_decay_at) / 3600);
      const decayed = decayValence(
        existing.valence,
        hoursElapsed,
        e.MOOD_DECAY_RATE_PER_HOUR,
      );
      nextValence = clampValence(decayed + delta);
    } else {
      nextValence = clampValence(delta);
    }

    db.prepare(
      `INSERT INTO chat_mood (chat_id, valence, last_event_at, last_decay_at, last_event_summary)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         valence = excluded.valence,
         last_event_at = excluded.last_event_at,
         last_decay_at = excluded.last_decay_at,
         last_event_summary = excluded.last_event_summary`,
    ).run(chatId, nextValence, now, now, summary.slice(0, 200));

    logger.debug(
      { chatId, delta, summary, valence: nextValence },
      'Mood event applied',
    );
  } catch (err) {
    logger.debug({ err, chatId }, 'applyMoodEvent failed (non-critical)');
  }
}

/**
 * Generate a prompt-injectable hint describing current mood.
 * Returns empty string when |valence| below MOOD_INJECT_THRESHOLD or MOOD_INJECT_ENABLED=false.
 */
export function moodPromptHint(state: MoodState): string {
  if (!env().MOOD_INJECT_ENABLED) return '';
  const threshold = env().MOOD_INJECT_THRESHOLD;
  if (Math.abs(state.valence) < threshold) return '';

  // 裸叙述,不带标签:唯一消费方是 composeSelfState 的第一人称叙事,
  // 带【标签】会原样嵌进句子中间(strip 正则只认半角 [])
  switch (state.bucket) {
    case 'cheerful':
      return '今天群里气氛好,你心情飘飘的,说话轻快爱接梗';
    case 'good':
      return '最近群里互动不错,你心情还行,比平时松弛一点';
    case 'down':
      return '最近被晾了几次,你有点蔫,话偏短偏冷,懒得接梗';
    case 'grumpy':
      return '最近被怼得不轻,你心里有点烦,说话短促没耐心(但不骂回去)';
    case 'calm':
    default:
      return '';
  }
}

/** @internal test helper */
export const _internal = { clampValence };
