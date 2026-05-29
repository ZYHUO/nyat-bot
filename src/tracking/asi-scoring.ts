// ────────────────────────────────────────
// ASI (Aggregate Social Index) reply-quality scoring
// Fire-and-forget. Triggered ONLY for finalized replies that received >=1
// followup (a reply, mention, or explicit reaction). Runs a small internal
// LLM rubric over {trigger, reply, signal}, combines it with the deterministic
// behavior signal, persists per-row scores, and maintains a rolling EMA per
// chat. The rolling uncanny-risk EMA is used to self-tune the humanizer (#4).
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export const ASI_ENABLED = true; // tunable
export const ASI_SAMPLE_RATE = 0.5; // tunable — fraction of eligible rows to score

const EMA_ALPHA = 0.3; // tunable — weight of the newest sample in the rolling EMA
const ASI_KEY_PREFIX = 'xxb:reply:asi:';
const UNCANNY_KEY_PREFIX = 'xxb:reply:uncanny:';
const HUMANIZER_OVERRIDE_PREFIX = 'xxb:humanizer:override:';
const EMA_TTL = 60 * 60 * 24 * 30; // 30 days

// #4 humanizer self-tune thresholds
const UNCANNY_DECREASE_THRESHOLD = 0.6; // tunable — above this, dial humanizer effects down
const UNCANNY_RECOVER_THRESHOLD = 0.4; // tunable — below this, nudge back toward defaults
const TUNE_STEP = 0.02; // tunable — how much each rate moves per scored followup

// Default rates the override recovers toward (must match humanizer defaults).
const HUMANIZER_DEFAULTS = { typoRate: 0.1, emojiReplyRate: 0.15, thinkingInterjectionRate: 0.1 };

export interface ScoreReplyQualityArgs {
  chatId: number;
  rowId: number;
  triggerText: string;
  replyText: string;
  /** The behavior signal that finalized this row (explicit_positive/negative, repair_loop, user_replied, ...) */
  signal: string;
}

interface Rubric {
  social_presence: number;
  warmth: number;
  competence: number;
  appropriateness: number;
  uncanny_risk: number;
}

function clamp01(x: unknown): number {
  const n = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Map the deterministic behavior signal → a behavior quality score in 0..1
 * plus the two friction flags (explicit negative / repair loop).
 */
export function deriveBehaviorScore(signal: string): {
  behavior: number;
  relational: number;
  explicitNegative: number;
  repairLoop: number;
} {
  switch (signal) {
    case 'explicit_positive':
      return { behavior: 1, relational: 1, explicitNegative: 0, repairLoop: 0 };
    case 'user_replied':
    case 'user_mentioned_bot':
      return { behavior: 0.75, relational: 0.7, explicitNegative: 0, repairLoop: 0 };
    case 'repair_loop':
      return { behavior: 0.1, relational: 0.2, explicitNegative: 1, repairLoop: 1 };
    case 'explicit_negative':
      return { behavior: 0, relational: 0.1, explicitNegative: 1, repairLoop: 0 };
    default:
      return { behavior: 0.5, relational: 0.5, explicitNegative: 0, repairLoop: 0 };
  }
}

/**
 * Combine rubric + behavior into the final ASI (0..100).
 * friction = 0.4*explicit_negative + 0.3*repair_loop + 0.3*uncanny_risk
 * ASI = round(100 * (0.45*behavior + 0.35*relational + 0.20*(1 - friction)))
 */
export function computeAsi(args: {
  behavior: number;
  relational: number;
  explicitNegative: number;
  repairLoop: number;
  uncannyRisk: number;
}): number {
  const behavior = clamp01(args.behavior);
  const relational = clamp01(args.relational);
  const explicitNegative = clamp01(args.explicitNegative);
  const repairLoop = clamp01(args.repairLoop);
  const uncannyRisk = clamp01(args.uncannyRisk);
  const friction = clamp01(0.4 * explicitNegative + 0.3 * repairLoop + 0.3 * uncannyRisk);
  const asi = 100 * (0.45 * behavior + 0.35 * relational + 0.2 * (1 - friction));
  return Math.round(asi);
}

function buildRubricPrompt(triggerText: string, replyText: string, followupSignal: string): string {
  return `你是一个聊天机器人回复质量的内部评测模块。根据「触发消息」「机器人回复」「用户后续反应信号」，对这条回复打分。

触发消息: ${triggerText.slice(0, 400)}
机器人回复: ${replyText.slice(0, 400)}
用户后续反应信号: ${followupSignal}

请从 5 个维度评估，每个维度输出 0 到 1 之间的小数：
- social_presence: 回复是否自然、像真人在场参与对话
- warmth: 回复的友好与体贴程度
- competence: 回复是否切题、有信息量、解决了对方的问题
- appropriateness: 回复在语境中是否得体、不冒犯、不答非所问
- uncanny_risk: 回复显得机械/出戏/过度做作/不像人类的风险（越高越糟）

只输出一个 JSON 对象，不要解释，不要 markdown：
{"social_presence":0.0,"warmth":0.0,"competence":0.0,"appropriateness":0.0,"uncanny_risk":0.0}`;
}

function parseRubric(content: string): Rubric | null {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      social_presence: clamp01(obj.social_presence),
      warmth: clamp01(obj.warmth),
      competence: clamp01(obj.competence),
      appropriateness: clamp01(obj.appropriateness),
      uncanny_risk: clamp01(obj.uncanny_risk),
    };
  } catch {
    return null;
  }
}

interface Ema {
  avg: number;
  n: number;
}

async function loadEma(key: string): Promise<Ema> {
  try {
    const raw = await getRedis().get(key);
    if (!raw) return { avg: 0, n: 0 };
    const parsed = JSON.parse(raw) as Partial<Ema>;
    return { avg: clampNum(parsed.avg), n: Math.max(0, Math.floor(Number(parsed.n) || 0)) };
  } catch {
    return { avg: 0, n: 0 };
  }
}

function clampNum(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function nextEma(prev: Ema, sample: number): Ema {
  if (prev.n === 0) return { avg: sample, n: 1 };
  const avg = prev.avg + EMA_ALPHA * (sample - prev.avg);
  return { avg, n: prev.n + 1 };
}

async function saveEma(key: string, ema: Ema): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify({ avg: ema.avg, n: ema.n }), 'EX', EMA_TTL);
  } catch (err) {
    logger.debug({ err, key }, 'ASI: saveEma failed (non-critical)');
  }
}

/**
 * #4 — self-tune the per-chat humanizer override based on the rolling
 * uncanny-risk EMA. High uncanny risk → dial down typo/emoji/thinking rates.
 * Low uncanny risk → recover toward defaults. Floored at 0 and capped at the
 * default. No-op when comfortably in the middle band.
 */
async function adjustHumanizerOverride(chatId: number, uncannyAvg: number): Promise<void> {
  const shouldDecrease = uncannyAvg >= UNCANNY_DECREASE_THRESHOLD;
  const shouldRecover = uncannyAvg < UNCANNY_RECOVER_THRESHOLD;
  if (!shouldDecrease && !shouldRecover) {
    return; // middle band — leave as-is
  }
  const key = HUMANIZER_OVERRIDE_PREFIX + chatId;
  const redis = getRedis();
  try {
    const raw = await redis.get(key);
    const cur = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    const get = (k: keyof typeof HUMANIZER_DEFAULTS): number =>
      typeof cur[k] === 'number' ? cur[k]! : HUMANIZER_DEFAULTS[k];

    let typoRate = get('typoRate');
    let emojiReplyRate = get('emojiReplyRate');
    let thinkingInterjectionRate = get('thinkingInterjectionRate');

    if (shouldDecrease) {
      // dial down, floored at 0
      typoRate = Math.max(0, typoRate - TUNE_STEP);
      emojiReplyRate = Math.max(0, emojiReplyRate - TUNE_STEP);
      thinkingInterjectionRate = Math.max(0, thinkingInterjectionRate - TUNE_STEP);
    } else {
      // recover toward defaults, capped at default
      typoRate = Math.min(HUMANIZER_DEFAULTS.typoRate, typoRate + TUNE_STEP);
      emojiReplyRate = Math.min(HUMANIZER_DEFAULTS.emojiReplyRate, emojiReplyRate + TUNE_STEP);
      thinkingInterjectionRate = Math.min(
        HUMANIZER_DEFAULTS.thinkingInterjectionRate,
        thinkingInterjectionRate + TUNE_STEP,
      );
    }

    const next = {
      typoRate: round3(typoRate),
      emojiReplyRate: round3(emojiReplyRate),
      thinkingInterjectionRate: round3(thinkingInterjectionRate),
    };

    // If fully recovered to defaults, drop the override entirely (cleanest null state).
    const atDefaults =
      next.typoRate === HUMANIZER_DEFAULTS.typoRate &&
      next.emojiReplyRate === HUMANIZER_DEFAULTS.emojiReplyRate &&
      next.thinkingInterjectionRate === HUMANIZER_DEFAULTS.thinkingInterjectionRate;

    if (atDefaults) {
      await redis.del(key);
    } else {
      await redis.set(key, JSON.stringify(next), 'EX', EMA_TTL);
    }
    logger.debug({ chatId, uncannyAvg, override: atDefaults ? null : next }, 'ASI: humanizer self-tune');
  } catch (err) {
    logger.debug({ err, chatId }, 'ASI: adjustHumanizerOverride failed (non-critical)');
  }
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export async function scoreReplyQuality(args: ScoreReplyQualityArgs): Promise<void> {
  const { chatId, rowId, triggerText, replyText, signal } = args;

  const { behavior, relational, explicitNegative, repairLoop } = deriveBehaviorScore(signal);

  // Internal rubric LLM call (low temperature). On failure, fall back to a
  // neutral rubric so behavior+friction still produce a usable ASI.
  let rubric: Rubric | null = null;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [{ role: 'user', content: buildRubricPrompt(triggerText, replyText, signal) }],
      temperature: 0.1,
      maxTokens: 120,
    });
    rubric = parseRubric(result.content);
  } catch (err) {
    logger.debug({ err, chatId, rowId }, 'ASI: rubric LLM call failed, using neutral rubric');
  }

  const eff: Rubric = rubric ?? {
    social_presence: 0.5,
    warmth: 0.5,
    competence: 0.5,
    appropriateness: 0.5,
    uncanny_risk: explicitNegative ? 0.5 : 0.2,
  };

  const asi = computeAsi({
    behavior,
    relational,
    explicitNegative,
    repairLoop,
    uncannyRisk: eff.uncanny_risk,
  });

  // Persist per-row scores.
  try {
    getDb()
      .prepare(
        `UPDATE reply_outcomes SET
           rubric_social_presence = ?,
           rubric_warmth = ?,
           rubric_competence = ?,
           rubric_appropriateness = ?,
           rubric_uncanny_risk = ?,
           friction_explicit_negative = ?,
           friction_repair_loop = ?,
           asi_final = ?
         WHERE id = ?`,
      )
      .run(
        eff.social_presence,
        eff.warmth,
        eff.competence,
        eff.appropriateness,
        eff.uncanny_risk,
        explicitNegative,
        repairLoop,
        asi,
        rowId,
      );
  } catch (err) {
    logger.debug({ err, chatId, rowId }, 'ASI: UPDATE reply_outcomes failed (non-critical)');
  }

  // Roll the per-chat EMAs.
  const asiKey = ASI_KEY_PREFIX + chatId;
  const uncannyKey = UNCANNY_KEY_PREFIX + chatId;
  const prevAsi = await loadEma(asiKey);
  const prevUncanny = await loadEma(uncannyKey);
  const nextAsi = nextEma(prevAsi, asi);
  const nextUncanny = nextEma(prevUncanny, eff.uncanny_risk);
  await saveEma(asiKey, nextAsi);
  await saveEma(uncannyKey, nextUncanny);

  // #4 — self-tune the humanizer off the rolling uncanny EMA.
  await adjustHumanizerOverride(chatId, nextUncanny.avg);
}
