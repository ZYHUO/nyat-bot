// ────────────────────────────────────────
// Humanizer — MaiBot-style human simulation effects
// Typo injection, read delay, acknowledgment prefix,
// delete-and-resend, typing jitter
// ────────────────────────────────────────

import { logger } from '../../shared/logger.js';

// ─── Configuration ───

export interface HumanizerConfig {
  /** Enable typo injection */
  typoEnabled: boolean;
  /** Probability a character gets typoed (0-1) */
  typoRate: number;
  /** Probability of correcting a typo (0-1). 1.0 = always correct. Correction mode is 50/50: edit original vs append in next message */
  typoCorrectionRate: number;
  /** Delay before correction message (seconds) */
  typoCorrectionDelay: number;

  /** Enable read simulation delay */
  readDelayEnabled: boolean;
  /** Base delay in seconds before starting to "type" after receiving a message */
  readDelayBase: number;
  /** Additional seconds per character of the incoming message */
  readDelayPerChar: number;
  /** Max read delay (seconds) */
  readDelayMax: number;

  /** Enable short acknowledgment prefix for long replies */
  ackPrefixEnabled: boolean;
  /** Probability of sending an acknowledgment prefix before a long reply */
  ackPrefixRate: number;
  /** Minimum reply length (chars) to trigger acknowledgment prefix */
  ackPrefixMinLength: number;
  /** Pool of acknowledgment prefixes to randomly pick from */
  ackPrefixPool: string[];
  /** Delay between ack prefix and main reply (seconds) */
  ackPrefixDelay: number;

  /** Enable delete-and-resend */
  deleteResendEnabled: boolean;
  /** Probability of deleting and resending a message (0-1) */
  deleteResendRate: number;
  /** Delay before deleting (seconds) — gives user time to see original */
  deleteResendDeleteDelay: number;

  /** Enable typing delay jitter */
  jitterEnabled: boolean;
  /** Jitter factor: actual delay = calculated * (1 ± jitterFactor) */
  jitterFactor: number;

  /** Enable emoji-only short replies */
  emojiReplyEnabled: boolean;
  /** Probability of replacing a short reply with an emoji (0-1) */
  emojiReplyRate: number;
  /** Maximum reply length (chars) to consider for emoji replacement */
  emojiReplyMaxLength: number;
  /** Pool of emojis for short replies */
  emojiPool: string[];

  /** Enable "thinking" interjection segments */
  thinkingInterjectionEnabled: boolean;
  /** Probability of inserting a thinking interjection (0-1) */
  thinkingInterjectionRate: number;
  /** Minimum total reply length (chars) to trigger thinking interjection */
  thinkingInterjectionMinTotalLength: number;
  /** Minimum number of segments to trigger thinking interjection */
  thinkingInterjectionMinSegments: number;
  /** Pool of "thinking" interjection texts */
  thinkingPool: string[];

  /** Enable casual afterthought edit */
  afterthoughtEditEnabled: boolean;
  /** Probability of editing a sent message with a minor tweak (0-1) */
  afterthoughtEditRate: number;
  /** Delay after sending before applying afterthought edit (seconds) */
  afterthoughtEditDelay: number;
}

const DEFAULT_HUMANIZER_CONFIG: HumanizerConfig = {
  typoEnabled: true,
  typoRate: 0.1,
  typoCorrectionRate: 1.0,
  typoCorrectionDelay: 1.5,

  readDelayEnabled: true,
  readDelayBase: 0.8,
  readDelayPerChar: 0.04,
  readDelayMax: 5.0,

  ackPrefixEnabled: true,
  ackPrefixRate: 0.25,
  ackPrefixMinLength: 30,
  ackPrefixPool: ['嗯', '嗯嗯', '..', '...', '啊', '哦'],
  ackPrefixDelay: 1.5,

  deleteResendEnabled: true,
  deleteResendRate: 0.03,
  deleteResendDeleteDelay: 1.5,

  jitterEnabled: true,
  jitterFactor: 0.2,

  emojiReplyEnabled: true,
  emojiReplyRate: 0.15,
  emojiReplyMaxLength: 15,
  emojiPool: ['👌', '😂', '🙏', '👍', '❤️', '😊', '🤔', '😅', '😍', '🥺', '💪', '🎉', '👀', '💀', '🫡', '🙃'],

  thinkingInterjectionEnabled: true,
  thinkingInterjectionRate: 0.10,
  thinkingInterjectionMinTotalLength: 80,
  thinkingInterjectionMinSegments: 3,
  thinkingPool: ['我想想', '等下', '嗯...', '让我看看', '怎么说呢'],

  afterthoughtEditEnabled: true,
  afterthoughtEditRate: 0.05,
  afterthoughtEditDelay: 3.0,
};

// ─── Typo Generator ───
// Simplified Chinese typo injection using common confusion pairs
// (No pinyin library needed — uses pre-built character substitution tables)

/** Common visual/sound-alike character substitutions for Chinese typing */
const TYPO_PAIRS: Array<[string, string]> = [
  // Sound-alike (pinyin confusion)
  ['的', '得'], ['得', '的'], ['的', '地'], ['地', '的'],
  ['在', '再'], ['再', '在'],
  ['了', '乐'], ['做', '作'], ['作', '做'],
  ['到', '道'], ['道', '到'],
  ['使', '是'], ['是', '使'],
  ['因', '应'], ['应', '因'],
  ['很', '跟'], ['跟', '很'],
  ['那', '哪'], ['哪', '那'],
  ['没', '美'], ['和', '何'],
  ['会', '回'], ['回', '会'],
  ['对', '队'], ['队', '对'],
  ['过', '各'], ['各', '过'],
  ['说', '硕'], ['生', '声'],
  ['想', '向'], ['向', '想'],
  ['去', '趣'], ['来', '莱'],
  ['他', '她'], ['她', '他'],
  ['嘛', '吗'], ['吗', '嘛'],
  ['吧', '把'], ['把', '吧'],
  ['还', '孩'], ['就', '旧'],
  ['人', '认'], ['认', '人'],
  ['这', '着'], ['着', '这'],
  ['有', '又'], ['又', '有'],
  ['也', '业'], ['都', '读'],
  ['能', '年'], ['年', '能'],
  ['我', '握'], ['你', '泥'],
  ['不', '步'], ['好', '号'],
  // Common keyboard typos (adjacent keys)
  ['一', '以'], ['以', '一'],
  ['个', '各'], ['大', '打'],
  ['上', '伤'], ['下', '吓'],
  ['中', '种'], ['种', '中'],
];

const TYPO_MAP = new Map<string, string[]>();
for (const [a, b] of TYPO_PAIRS) {
  if (!TYPO_MAP.has(a)) TYPO_MAP.set(a, []);
  TYPO_MAP.get(a)!.push(b);
}

/** Characters that should never be typoed (structural, short, or punctuation) */
function shouldSkipTypo(char: string, text: string, idx: number): boolean {
  // Never typo first or last char
  if (idx === 0 || idx === text.length - 1) return true;
  // Never typo non-CJK
  const code = char.charCodeAt(0);
  if (code < 0x4e00 || code > 0x9fff) return true;

  // Check neighbors: skip if neighbor is emoji, punctuation, or whitespace
  const isSkipNeighbor = (c: string): boolean => {
    const cp = c.codePointAt(0)!;
    // Emoji ranges
    if (cp >= 0x1F600 && cp <= 0x1F64F) return true; // Emoticons
    if (cp >= 0x1F300 && cp <= 0x1F5FF) return true; // Misc Symbols
    if (cp >= 0x1F680 && cp <= 0x1F6FF) return true; // Transport
    if (cp >= 0x1F900 && cp <= 0x1F9FF) return true; // Supplemental
    if (cp >= 0x2600 && cp <= 0x26FF) return true;    // Misc symbols
    if (cp >= 0x2700 && cp <= 0x27BF) return true;    // Dingbats
    if (cp >= 0xFE00 && cp <= 0xFE0F) return true;    // Variation selectors
    if (cp >= 0x1FA00 && cp <= 0x1FAFF) return true;  // Symbols extended
    // CJK punctuation
    if (cp >= 0x3000 && cp <= 0x303F) return true;
    // Fullwidth forms (punctuation)
    if (cp >= 0xFF00 && cp <= 0xFFEF) return true;
    // ASCII punctuation
    if (/[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/.test(c)) return true;
    // General punctuation (… etc)
    if (cp >= 0x2000 && cp <= 0x206F) return true;
    // Whitespace
    if (/\s/.test(c)) return true;
    return false;
  };

  const prevChar = text[idx - 1]!;
  const nextChar = text[idx + 1]!;
  if (isSkipNeighbor(prevChar) || isSkipNeighbor(nextChar)) return true;
  return false;
}

export interface TypoResult {
  /** The text with typos injected */
  typoedText: string;
  /** The original text before typo (for edit-based correction) */
  originalText: string;
  /** Correction mode: 'edit' = edit original message, 'append' = send correct word in next segment, null = no correction */
  correction: 'edit' | 'append' | null;
  /** The correct character/word to append (used when correction='append') */
  correctChar: string | null;
  /** Index of the typo in the text, or -1 if no typo */
  typoIndex: number;
}

/**
 * Inject a single typo into text with a given probability.
 * Returns the typoed text and optionally a correction.
 */
export function injectTypo(text: string, config?: Partial<HumanizerConfig>): TypoResult {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.typoEnabled || Math.random() > cfg.typoRate) {
    // typoRate is per-character but we check per-message with amplified probability
    // so if rate=0.03, each message has ~30% chance of at least one typo for avg 10-char msg
    return { typoedText: text, originalText: text, correction: null, correctChar: null, typoIndex: -1 };
  }

  // Find all candidate positions
  const candidates: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (shouldSkipTypo(char, text, i)) continue;
    if (!TYPO_MAP.has(char)) continue;
    candidates.push(i);
  }

  if (candidates.length === 0) {
    return { typoedText: text, originalText: text, correction: null, correctChar: null, typoIndex: -1 };
  }

  // Pick one random position
  const typoIdx = candidates[Math.floor(Math.random() * candidates.length)]!;
  const originalChar = text[typoIdx]!;
  const replacements = TYPO_MAP.get(originalChar)!;
  const replacement = replacements[Math.floor(Math.random() * replacements.length)]!;

  let typoedText = text.slice(0, typoIdx) + replacement + text.slice(typoIdx + 1);

  // Decide correction mode: 50% edit original message, 50% append correct char in next segment
  // "edit" = fix the typo by editing the original message
  // "append" = don't fix, just send the correct character in the next reply (like a human too lazy to edit)
  let correction: 'edit' | 'append' | null = null;
  let correctChar: string | null = null;
  if (Math.random() < cfg.typoCorrectionRate) {
    if (Math.random() < 0.5) {
      correction = 'edit';
    } else {
      correction = 'append';
      correctChar = originalChar;
    }
  }

  logger.debug({ originalChar, replacement, correction: correction ?? 'none' }, 'Typo injected');
  return { typoedText, originalText: text, correction, correctChar, typoIndex: typoIdx };
}

// ─── Read Delay ───

/**
 * Calculate the read delay (seconds) based on the incoming message length.
 * Simulates the time a human would take to read before starting to type.
 */
export function calculateReadDelay(incomingMessageLength: number, config?: Partial<HumanizerConfig>): number {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.readDelayEnabled) return 0;

  let delay = cfg.readDelayBase + incomingMessageLength * cfg.readDelayPerChar;
  delay = Math.min(delay, cfg.readDelayMax);

  if (cfg.jitterEnabled) {
    delay = applyJitter(delay, cfg.jitterFactor);
  }

  return delay;
}

// ─── Acknowledgment Prefix ───

export interface AckPrefixResult {
  /** Whether to send a prefix */
  shouldSend: boolean;
  /** The prefix text, or null */
  prefix: string | null;
  /** Delay after prefix before main reply (seconds) */
  delay: number;
}

/**
 * Decide whether to send a short acknowledgment prefix before a long reply.
 */
export function decideAckPrefix(replyLength: number, config?: Partial<HumanizerConfig>): AckPrefixResult {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.ackPrefixEnabled) {
    return { shouldSend: false, prefix: null, delay: 0 };
  }

  if (replyLength < cfg.ackPrefixMinLength) {
    return { shouldSend: false, prefix: null, delay: 0 };
  }

  if (Math.random() > cfg.ackPrefixRate) {
    return { shouldSend: false, prefix: null, delay: 0 };
  }

  const prefix = cfg.ackPrefixPool[Math.floor(Math.random() * cfg.ackPrefixPool.length)]!;
  const delay = cfg.jitterEnabled ? applyJitter(cfg.ackPrefixDelay, cfg.jitterFactor) : cfg.ackPrefixDelay;

  return { shouldSend: true, prefix, delay };
}

// ─── Delete & Resend ───

export interface DeleteResendResult {
  /** Whether to delete-and-resend this message */
  shouldDeleteResend: boolean;
  /** Delay before deleting (seconds) */
  deleteDelay: number;
  /** The modified text (slightly different from original) */
  modifiedText: string;
}

/** Small text tweaks for delete-and-resend */
function tweakText(text: string): string {
  const tweaks: Array<() => string> = [
    // Add trailing punctuation
    () => {
      const last = text[text.length - 1];
      if (last && !/[。！？!?.，,]/.test(last)) return text + '。';
      // Remove trailing period/comma
      return text.replace(/[。，]$/, '');
    },
    // Remove a comma somewhere
    () => {
      const commaIdx = text.indexOf('，');
      if (commaIdx > 0) return text.slice(0, commaIdx) + text.slice(commaIdx + 1);
      return text;
    },
    // Add a particle
    () => {
      const particles = ['啊', '呢', '呀', '吧', '哦', '哈'];
      const p = particles[Math.floor(Math.random() * particles.length)]!;
      return text + p;
    },
  ];
  return tweaks[Math.floor(Math.random() * tweaks.length)]!();
}

/**
 * Decide whether to delete-and-resend a message.
 * Only applies to non-first messages (segments after the first).
 */
export function decideDeleteResend(
  segmentIndex: number,
  _totalSegments: number,
  text: string,
  config?: Partial<HumanizerConfig>,
): DeleteResendResult {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.deleteResendEnabled) {
    return { shouldDeleteResend: false, deleteDelay: 0, modifiedText: text };
  }

  // Only middle/last segments, and only with some probability
  if (segmentIndex === 0 || Math.random() > cfg.deleteResendRate) {
    return { shouldDeleteResend: false, deleteDelay: 0, modifiedText: text };
  }

  const deleteDelay = cfg.jitterEnabled
    ? applyJitter(cfg.deleteResendDeleteDelay, cfg.jitterFactor)
    : cfg.deleteResendDeleteDelay;

  const modified = tweakText(text);
  // If tweakText didn't actually change anything, skip delete-resend (no-op)
  if (modified === text) {
    return { shouldDeleteResend: false, deleteDelay: 0, modifiedText: text };
  }

  return {
    shouldDeleteResend: true,
    deleteDelay,
    modifiedText: modified,
  };
}

// ─── Jitter ───

/**
 * Apply ±jitterFactor random variation to a delay value.
 * E.g., jitter(2.0, 0.2) → random between 1.6 and 2.4
 */
export function applyJitter(delay: number, jitterFactor: number): number {
  const variation = delay * jitterFactor;
  return Math.max(0, delay + (Math.random() * 2 - 1) * variation);
}

// (humanizeReply and HumanizerResult removed — pipeline calls individual functions directly)

// ─── Sticker-Only Short Replies ───

export interface StickerOnlyReplyResult {
  /** Whether to replace the reply with a sticker-only message */
  shouldReplace: boolean;
  /** Sticker intent to search for (e.g. 'positive', 'acknowledgment') */
  intent: string;
}

/** Common intents for short sticker replies mimicking human behavior */
const STICKER_REPLY_INTENTS = [
  'positive', 'acknowledgment', 'agreement', 'happy',
  'thinking', 'surprise', 'neutral',
];

/**
 * Decide whether to replace a short reply with a sticker-only message.
 * Returns a sticker intent to search for; the pipeline will resolve the actual sticker.
 */
export function decideStickerOnlyReply(replyLength: number, config?: Partial<HumanizerConfig>): StickerOnlyReplyResult {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.emojiReplyEnabled || replyLength > cfg.emojiReplyMaxLength) {
    return { shouldReplace: false, intent: '' };
  }

  if (Math.random() > cfg.emojiReplyRate) {
    return { shouldReplace: false, intent: '' };
  }

  const intent = STICKER_REPLY_INTENTS[Math.floor(Math.random() * STICKER_REPLY_INTENTS.length)]!;
  logger.debug({ intent, replyLength }, 'Humanizer: sticker-only reply selected');
  return { shouldReplace: true, intent };
}

/**
 * @deprecated Use decideStickerOnlyReply instead.
 * Kept for backwards compatibility with runtime config.
 */
export function decideEmojiReply(replyLength: number, config?: Partial<HumanizerConfig>): StickerOnlyReplyResult {
  return decideStickerOnlyReply(replyLength, config);
}

// ─── Thinking Interjection ───

export interface ThinkingResult {
  /** Whether to insert a thinking interjection */
  shouldInsert: boolean;
  /** The interjection text */
  text: string;
}

/**
 * Decide whether to insert a "thinking" interjection between
 * the first and second reply segments.
 */
export function decideThinkingInterjection(
  totalLength: number,
  segmentCount: number,
  config?: Partial<HumanizerConfig>,
): ThinkingResult {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.thinkingInterjectionEnabled) {
    return { shouldInsert: false, text: '' };
  }

  if (totalLength < cfg.thinkingInterjectionMinTotalLength) {
    return { shouldInsert: false, text: '' };
  }

  if (segmentCount < cfg.thinkingInterjectionMinSegments) {
    return { shouldInsert: false, text: '' };
  }

  if (Math.random() > cfg.thinkingInterjectionRate) {
    return { shouldInsert: false, text: '' };
  }

  const text = cfg.thinkingPool[Math.floor(Math.random() * cfg.thinkingPool.length)]!;
  logger.debug({ text, totalLength, segmentCount }, 'Humanizer: thinking interjection selected');
  return { shouldInsert: true, text };
}

// ─── Afterthought Edit ───

export interface AfterthoughtResult {
  /** Whether to apply an afterthought edit */
  shouldEdit: boolean;
  /** The edited text */
  editedText: string;
}

/** Casual text tweaks for afterthought edits */
function casualTweak(text: string): string {
  const r = Math.random();
  const last = text[text.length - 1];

  // Add trailing emoji — 35%
  if (r < 0.35) {
    const emojis = ['😂', '👍', '🤣', '✨', '💕'];
    return text + emojis[Math.floor(Math.random() * emojis.length)]!;
  }

  // Add trailing particle — 25%
  if (r < 0.60) {
    const particles = ['啊', '呢', '呀', '哦'];
    return text + particles[Math.floor(Math.random() * particles.length)]!;
  }

  // Remove trailing period/comma — 20%
  if (r < 0.80) {
    if (last && /[。，！？]/.test(last)) {
      return text.slice(0, -1);
    }
    return text;
  }

  // Add trailing period if none — 15%
  if (r < 0.95) {
    if (last && !/[。！？!?.，,…]/.test(last)) {
      return text + '。';
    }
    return text;
  }

  // Swap a common word (5%)
  const swaps: Array<[string, string]> = [
    ['真的', '真'],
    ['非常', '特别'],
    ['这个', '这'],
  ];
  for (const [from, to] of swaps) {
    if (text.includes(from)) {
      return text.replace(from, to);
    }
  }
  return text;
}

/**
 * Decide whether to edit a sent message with a casual afterthought tweak.
 * Only applies to messages ≥ 4 chars.
 */
export function decideAfterthoughtEdit(text: string, config?: Partial<HumanizerConfig>): AfterthoughtResult {
  const cfg = { ...DEFAULT_HUMANIZER_CONFIG, ...config };

  if (!cfg.afterthoughtEditEnabled) {
    return { shouldEdit: false, editedText: text };
  }

  if (text.length < 4) {
    return { shouldEdit: false, editedText: text };
  }

  if (Math.random() > cfg.afterthoughtEditRate) {
    return { shouldEdit: false, editedText: text };
  }

  const editedText = casualTweak(text);
  // If the tweak didn't actually change anything, skip the edit
  if (editedText === text) {
    return { shouldEdit: false, editedText: text };
  }

  logger.debug({ original: text, edited: editedText }, 'Humanizer: afterthought edit selected');
  return { shouldEdit: true, editedText };
}

// ─── Re-export config defaults for external use ───

export { DEFAULT_HUMANIZER_CONFIG };
export type PartialHumanizerConfig = Partial<HumanizerConfig>;