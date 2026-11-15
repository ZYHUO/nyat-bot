// ────────────────────────────────────────
// Emoji reactions — lightweight "the cat noticed" signal via setMessageReaction.
// Deliberately RARE: hard cap of DAILY_CAP per chat per day, only for clearly
// funny/cute/cool messages, and only probabilistically. No LLM calls.
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { reactToMessage } from '../bot/sender/telegram.js';
import { logger } from '../shared/logger.js';

const DAILY_CAP = 2;            // tunable — max reactions per chat per day (user asked: 2)
const REACT_PROBABILITY = 0.35; // tunable — chance to react to an *eligible* message

// Sentiment buckets — all from Telegram's allowed reaction emoji set (exact codepoints;
// note the heart is U+2764 without the U+FE0F variation selector).
const FUNNY = ['😁', '🤣'];
const CUTE = ['🥰', '❤', '😍'];
const COOL = ['🔥', '💯', '👏'];

const FUNNY_RE = /哈哈|哈哈哈|hhh+|笑死|绝了|草{1,3}$|乐死|2333|🤣|😂|笑不活/i;
const CUTE_RE = /可爱|喜欢你|爱了|抱抱|乖乖|宝贝|么么|亲亲|贴贴|🥰|😘|💕|❤/;
const COOL_RE = /太强|牛[批逼b]|厉害|tql|nb|yyds|绝绝子|强爆|顶级|6{4,}|🔥/i;

function pick(arr: string[]): string { return arr[Math.floor(Math.random() * arr.length)]!; }

/**
 * 给心流的 react 出口挑一个 emoji。
 *
 * round 8（新 goal）：heart 多了 act=react。它不经过 chooseReaction 的正则
 * （那条路是"看到有趣的词就点一下"的副产品），而是心流已经决定要点、
 * 只差一个表情。所以这里按情绪桶给一个默认值，不再判"值不值得"。
 *
 * 'neutral' 对应没带情绪的那些场合（"我看见了""+1"）——用 👀，比 👍 更像
 * "在场但不想说话"。
 */
export function pickReactionEmoji(mood: 'funny' | 'cute' | 'cool' | 'neutral'): string {
  if (mood === 'funny') return pick(FUNNY);
  if (mood === 'cute') return pick(CUTE);
  if (mood === 'cool') return pick(COOL);
  return '👀';
}

/** Pick a sentiment-matched reaction emoji, or null if the text isn't reaction-worthy. */
export function chooseReaction(text: string): string | null {
  if (!text) return null;
  if (FUNNY_RE.test(text)) return pick(FUNNY);
  if (CUTE_RE.test(text)) return pick(CUTE);
  if (COOL_RE.test(text)) return pick(COOL);
  return null;
}

function dayKey(chatId: number): string {
  // Asia/Shanghai calendar day, so the cap resets at local midnight.
  const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  return `xxb:react:${chatId}:${d}`;
}

/**
 * Maybe react to a salient group message. Fire-and-forget; never throws.
 * Gating order: sentiment match → probability roll → daily cap → react.
 */
export async function maybeReact(chatId: number, messageId: number, text: string): Promise<void> {
  try {
    if (chatId >= 0 || !messageId) return; // groups only
    const emoji = chooseReaction(text);
    if (!emoji) return;
    if (Math.random() >= REACT_PROBABILITY) return;

    // 硬作息:睡着的猫不会点表情(凌晨三点冒出 reaction 会穿帮)
    const { isAsleep } = await import('../tracking/sleep.js');
    if (await isAsleep()) return;

    // Atomic daily cap: only the first DAILY_CAP eligible+rolled messages react.
    const redis = getRedis();
    const key = dayKey(chatId);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 30 * 3600); // outlives the day, self-clears
    if (n > DAILY_CAP) return;

    const ok = await reactToMessage(chatId, messageId, emoji);
    if (ok) logger.debug({ chatId, messageId, emoji, todayCount: n }, 'Reacted to message');
  } catch (err) {
    logger.debug({ err, chatId }, 'maybeReact failed (non-critical)');
  }
}
