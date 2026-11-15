// Participation budget: physical throttling the model can see and reason about.
//
// WHY THIS EXISTS (NyatOS Phase 2.3 negative result, 2026-09-18)
//
// The plan was to delete the timing gates and let a single decision point
// choose when to speak. A 54-sample shadow run showed that does not work:
//
//   shadow wanted to speak 48 times in 28 minutes
//   median gap between "speak" verdicts: 7 seconds (42 of 47 gaps under 60s)
//   the live path sent 0 messages in the same window
//
// Four rounds of investigation ruled out the easy explanations (token
// truncation, frame rendering, prompt framing, missing self-history). The
// decisive experiment: even when told as a plain fact "you sent 4 messages in
// the last 2 minutes and 3 got no response", the model still chose to speak.
//
// So the old cooldown was doing two jobs, and only one of them was wrong:
//   - deciding WHAT is worth saying  → genuinely should move to the model
//   - preventing runaway self-repetition → the model cannot be trusted with it
//
// This module keeps the second job in the host, but changes its character:
// instead of a hidden timer that silently drops messages, it is a *budget* the
// model can see, spend, and reason about. A person in a group does not have a
// 90-second lockout; they have a sense that they have been talking a lot.
//
// It is a reality bound (like a message length cap), not a behavioural rule:
// it never says what to say, only how much of a scarce resource is left.

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

export interface ParticipationBudget {
  /** Active messages allowed in the current window. */
  limit: number;
  /** How many are left. */
  remaining: number;
  /** Window length in seconds. */
  windowSec: number;
  /** Seconds until the window rolls over. */
  resetsInSec: number;
}

const KEY_PREFIX = 'xxb:nyatos:budget:';

function key(chatId: number, windowSec: number): string {
  // Bucket by window so the counter rolls over naturally without a sweeper.
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  return `${KEY_PREFIX}${chatId}:${bucket}`;
}

function budgetEnabled(): boolean {
  try {
    return env().NYATOS_BUDGET_ENABLED === true;
  } catch {
    return false;
  }
}

function windowSec(): number {
  try {
    return Math.max(60, env().NYATOS_BUDGET_WINDOW_SEC);
  } catch {
    return 3600;
  }
}

function limit(): number {
  try {
    return Math.max(1, env().NYATOS_BUDGET_MAX_ACTS);
  } catch {
    return 6;
  }
}

/**
 * Read the remaining budget without consuming it.
 *
 * Returns null when the feature is off, so callers can render "no budget
 * information" rather than a misleading zero.
 */
export async function getParticipationBudget(
  chatId: number,
): Promise<ParticipationBudget | null> {
  if (!budgetEnabled() || !Number.isSafeInteger(chatId) || chatId === 0) return null;
  const sec = windowSec();
  const cap = limit();
  try {
    const used = Number((await getRedis().get(key(chatId, sec))) ?? 0);
    const elapsed = Math.floor(Date.now() / 1000) % sec;
    return {
      limit: cap,
      remaining: Math.max(0, cap - (Number.isFinite(used) ? used : 0)),
      windowSec: sec,
      resetsInSec: sec - elapsed,
    };
  } catch (err) {
    logger.debug({ err, chatId }, 'participation budget read failed');
    return null;
  }
}

/**
 * Consume one unit. Returns the state AFTER consuming, or null when off.
 *
 * The counter is incremented even past the limit so the render can say "you are
 * over" rather than silently clamping — an honest signal is more useful to the
 * model than a floor.
 */
export async function spendParticipation(
  chatId: number,
): Promise<ParticipationBudget | null> {
  if (!budgetEnabled() || !Number.isSafeInteger(chatId) || chatId === 0) return null;
  const sec = windowSec();
  const cap = limit();
  const k = key(chatId, sec);
  try {
    const redis = getRedis();
    const used = await redis.incr(k);
    if (used === 1) await redis.expire(k, sec * 2);
    const elapsed = Math.floor(Date.now() / 1000) % sec;
    return {
      limit: cap,
      remaining: Math.max(0, cap - used),
      windowSec: sec,
      resetsInSec: sec - elapsed,
    };
  } catch (err) {
    logger.debug({ err, chatId }, 'participation spend failed');
    return null;
  }
}

/**
 * Render the budget as a fact line for the Frame.
 *
 * Deliberately framed as a resource, not a rule: "you have N left this hour".
 * No "you should slow down", no per-message quota — the model decides what to
 * spend it on.
 */
export function renderParticipationBudget(budget: ParticipationBudget | null): string {
  if (!budget) return '';
  // Framed as a fact about what the bot has DONE, not a quota it is allowed.
  // A person knows "I've been talking a lot"; nobody knows "I have 2 of 6
  // remaining". The earlier quota framing leaked into the model's own reasoning
  // ("本小时主动发言额度已用完"), which is exactly the assistant mindset this
  // rewrite exists to remove.
  if (budget.remaining === 0) {
    return `[你最近] 这一个小时你已经说了 ${budget.limit} 条了。`;
  }
  const used = budget.limit - budget.remaining;
  if (used <= 0) return '';
  return `[你最近] 这一个小时你已经说了 ${used} 条。`;
}

/**
 * Whether an active (non-addressed) message may be sent right now.
 *
 * Addressed messages (someone @s the bot or replies to it) are NOT throttled:
 * ignoring a direct question is a different failure from over-participating,
 * and the old gates already treated direct interaction as exempt.
 */
export async function canSpeakActively(chatId: number): Promise<boolean> {
  const budget = await getParticipationBudget(chatId);
  if (!budget) return true;
  return budget.remaining > 0;
}

/**
 * Minimum spacing between active speeches, tracked separately from the count.
 *
 * WHY THIS IS A SEPARATE DIMENSION
 *
 * The count budget ("6 per hour") cannot stop a burst: six messages inside one
 * minute still passes it, and the Phase 2.3 shadow data showed exactly that
 * shape — 48 "speak" verdicts in 28 minutes with a median gap of 7 seconds.
 * A real person has both senses: "I have talked a lot today" AND "I just spoke,
 * let someone else talk". This is the second one.
 *
 * Like the count budget it is a reality bound, not a behavioural rule: it never
 * says what to say, only that the channel is momentarily occupied.
 */
const LAST_ACT_KEY_PREFIX = 'xxb:nyatos:lastact:';

/** Seconds remaining before another active message is allowed (0 = free). */
export async function activeSpeechCooldownRemainingSec(chatId: number): Promise<number> {
  if (!budgetEnabled() || !Number.isSafeInteger(chatId) || chatId === 0) return 0;
  let gapSec: number;
  try {
    gapSec = Math.max(0, env().NYATOS_BUDGET_MIN_GAP_SEC);
  } catch {
    return 0;
  }
  if (gapSec === 0) return 0;
  try {
    const last = Number((await getRedis().get(`${LAST_ACT_KEY_PREFIX}${chatId}`)) ?? 0);
    if (!Number.isFinite(last) || last <= 0) return 0;
    const elapsed = Math.floor(Date.now() / 1000) - last;
    return Math.max(0, gapSec - elapsed);
  } catch (err) {
    logger.debug({ err, chatId }, 'active speech cooldown read failed');
    return 0;
  }
}

/**
 * 两次**被叫到**的回复之间的最小间隔。
 *
 * 与 activeSpeechCooldownRemainingSec 分开的两个数：主动插话 90s，被叫到看
 * NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC（round 68 从 30s 改成 8s，原因见
 * env-sections/life.ts 的注释：30s 会把群友连着问三个问题时的后两个吐掉）。
 *
 * round 170（计划 3d）：这行注释之前写死的"30s"，而 .env 里实际是 8s——
 * 差一个数字，但让所有拿这行当事实的人（包括我）把刹车片想得厚 4 倍。
 * 理由——生产流量几乎全在"被叫到"那条路上（近 3 天 2702 次 host sendText 里
 * 1356 次显式带 replyTo、1340 次只有任务默认锚点），而原来那条路**一点间隔都
 * 没有**：5 分钟窗 p90=8、max=20，最忙群 19.4 条/小时。
 *
 * 这不是"不许回"：被叫到仍然优先，只是不许 5 秒内连回三个人。
 */
export async function addressedSpeechCooldownRemainingSec(chatId: number): Promise<number> {
  if (!budgetEnabled() || !Number.isSafeInteger(chatId) || chatId === 0) return 0;
  let gapSec: number;
  try {
    gapSec = Math.max(0, env().NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC);
  } catch {
    return 0;
  }
  if (gapSec === 0) return 0;
  try {
    const last = Number((await getRedis().get(`${LAST_ACT_KEY_PREFIX}${chatId}`)) ?? 0);
    if (!Number.isFinite(last) || last <= 0) return 0;
    const elapsed = Math.floor(Date.now() / 1000) - last;
    return Math.max(0, gapSec - elapsed);
  } catch (err) {
    logger.debug({ err, chatId }, 'addressed speech cooldown read failed');
    return 0;
  }
}

/** Mark that an active message just went out. */
export async function markActiveSpeech(chatId: number): Promise<void> {
  if (!budgetEnabled() || !Number.isSafeInteger(chatId) || chatId === 0) return;
  try {
    await getRedis().set(`${LAST_ACT_KEY_PREFIX}${chatId}`, String(Math.floor(Date.now() / 1000)));
  } catch (err) {
    logger.debug({ err, chatId }, 'markActiveSpeech failed');
  }
}

/** Render the spacing as a fact line, when the channel is momentarily occupied. */
export function renderActiveSpeechSpacing(remainingSec: number): string {
  if (remainingSec <= 0) return '';
  // A felt sense of "I just spoke", not a lockout timer. The host still uses
  // `remainingSec` to know when the channel frees up, but the model only needs
  // the human fact — it can decide for itself whether to hold back.
  return '[你最近] 你刚说过话。';
}
