// ────────────────────────────────────────
// Social need / willingness state (adapted from HumanoidAgents)
//
// HumanoidAgents models needs (social/fun/energy) that decline over time and
// condition WHEN an agent initiates + HOW it sounds. Their version runs a per-
// activity LLM call to judge each need — far too costly for a busy group bot.
//
// This is the cheap, state-conditioned adaptation:
//   - social need ("loneliness") is TIME-DERIVED from how long since the bot last
//     spoke in the chat (no LLM): lonelier the longer it's been quiet.
//   - mood (existing valence) and closeness (existing relationship affinity of the
//     people currently present) modulate willingness too.
// Together they replace the flat proactive probability with a state-aware one:
// the bot chimes in MORE when it's been lonely + people are friendly + mood is ok,
// and LESS right after it just talked, in a bad mood, or among hostile/strangers.
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getChatMood } from './mood.js';
import { getRelationship } from './relationship.js';
import type { FormattedMessage } from '../shared/types.js';

const LAST_SPOKE_PREFIX = 'xxb:social:lastspoke:';
const SOCIAL_NEED_FULL_HOURS = 3;      // tunable — fully "lonely" after this long without speaking
const NO_RECORD_NEED = 0.7;            // tunable — assumed need when we have no record
const MOOD_FLOOR = 0.45;               // tunable — worst-mood willingness multiplier
const CLOSENESS_LOW = -20;             // tunable — avg affinity below this = chillier crowd
const CLOSENESS_PENALTY = 0.55;        // tunable — willingness multiplier among a chilly crowd
const STATE_HINT_LONELY = 0.75;        // tunable — emit a "wants company" hint above this need

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Mark that the bot just spoke in a chat (resets the loneliness clock). */
export async function markBotSpoke(chatId: number): Promise<void> {
  try {
    await getRedis().set(LAST_SPOKE_PREFIX + chatId, String(Math.floor(Date.now() / 1000)), 'EX', 7 * 86400);
  } catch { /* non-critical */ }
}

/** bot 上次在该 chat 发言的 epoch 秒(无记录/读失败 → null)。 */
export async function getLastSpokeTs(chatId: number): Promise<number | null> {
  try {
    const raw = await getRedis().get(LAST_SPOKE_PREFIX + chatId);
    return raw ? parseInt(raw, 10) : null;
  } catch {
    return null;
  }
}

/** Loneliness ∈ [0,1]: 0 = just spoke, 1 = silent for ≥ SOCIAL_NEED_FULL_HOURS. */
export async function getSocialNeed(chatId: number): Promise<number> {
  try {
    const raw = await getRedis().get(LAST_SPOKE_PREFIX + chatId);
    if (!raw) return NO_RECORD_NEED;
    const hours = (Date.now() / 1000 - parseInt(raw, 10)) / 3600;
    return clamp(hours / SOCIAL_NEED_FULL_HOURS, 0, 1);
  } catch {
    return NO_RECORD_NEED;
  }
}

/** Average relationship affinity of the recent non-bot speakers (the present crowd). */
export function crowdCloseness(chatId: number, recent: FormattedMessage[]): number {
  const uids = [...new Set(recent.filter((m) => !m.isBot && m.role !== 'assistant' && m.uid).map((m) => m.uid))].slice(-10);
  if (uids.length === 0) return 0;
  let sum = 0;
  for (const uid of uids) {
    try { sum += getRelationship(chatId, uid).affinity; } catch { /* skip */ }
  }
  return sum / uids.length;
}

/** Pure willingness composition — exported for testing. */
export function composeWillingness(socialNeed: number, valence: number, avgAffinity: number): number {
  const moodFactor = clamp((valence + 100) / 200, MOOD_FLOOR, 1); // bad mood → down to floor
  const closenessFactor = avgAffinity < CLOSENESS_LOW ? CLOSENESS_PENALTY : 1;
  return clamp(socialNeed * moodFactor * closenessFactor, 0, 1);
}

/**
 * State-conditioned proactive willingness ∈ [0,1]. Multiply a base trigger by this,
 * or skip with probability (1 - willingness).
 */
export async function proactiveWillingness(chatId: number, recent: FormattedMessage[]): Promise<number> {
  const need = await getSocialNeed(chatId);
  let valence = 0;
  try { valence = getChatMood(chatId).valence; } catch { /* default neutral */ }
  return composeWillingness(need, valence, crowdCloseness(chatId, recent));
}

/** Tiny internal state hint for the prompt (group), or null. Subtle — drives tone, not neediness. */
export async function socialStateHint(chatId: number): Promise<string | null> {
  const need = await getSocialNeed(chatId);
  if (need >= STATE_HINT_LONELY) return '安静了好一会儿了，有点想找人说说话';
  return null;
}
