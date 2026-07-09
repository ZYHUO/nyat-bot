// ────────────────────────────────────────
// Message Segmenter — MaiBot-style human-like splitting
// Splits a single LLM reply into multiple natural chat bubbles
// ────────────────────────────────────────

import { logger } from '../../shared/logger.js';

// ─── Configuration ───

export interface SegmenterConfig {
  /** Enable punctuation-based splitting */
  enabled: boolean;
  /** Max characters per segment before forced split */
  maxLength: number;
  /** Max number of segments (overflow → return full text or fallback) */
  maxSentenceNum: number;
  /** On overflow, return full text (true) or default reply (false) */
  enableOverflowReturnAll: boolean;
  /** Default reply when text is empty or too long */
  defaultReply: string;
  /** Enable kaomoji protection */
  enableKaomojiProtection: boolean;
  /** Typing delay: seconds per Chinese character */
  typingChineseTime: number;
  /** Typing delay: seconds per English character */
  typingEnglishTime: number;
  /** Typing delay: minimum per message (seconds) */
  typingMinDelay: number;
  /** Typing delay: max per message (seconds), cap */
  typingMaxDelay: number;
  /** First message only uses quote-reply */
  firstMessageQuoteReply: boolean;
  /** #11 句尾句号去除概率(随群标点习惯漂移) */
  periodDropRate: number;
  /** 「喵」口癖抑制:分句后把过密的句尾喵稀释到约一半(tone.md「一半消息带上就好」) */
  thinMeow: boolean;
}

const DEFAULT_CONFIG: SegmenterConfig = {
  enabled: true,
  maxLength: 220,        // 每条更长，减少强切（之前 100）
  maxSentenceNum: 3,     // 最多拆 3 条（之前 8，太碎）
  enableOverflowReturnAll: true,
  defaultReply: '嗯',
  enableKaomojiProtection: true,
  typingChineseTime: 0.06,  // 打字延迟大幅降低（之前 0.25），加快
  typingEnglishTime: 0.03,  // 之前 0.12
  typingMinDelay: 0.3,      // 之前 0.8
  typingMaxDelay: 1.2,      // 每条最多等 1.2s（之前 4.0s，是"慢"的主因）
  firstMessageQuoteReply: true,
  periodDropRate: 0.9,
  thinMeow: true,
};

// 句尾「喵」口癖:喵(呜)? 后可跟波浪号/单个表情收尾。抓这个尾巴,决定去留时
// 只摘掉「喵」本体,保留核心话、波浪号和表情。
const MEOW_TAIL = /^([\s\S]*?)(喵+呜?)([~～]*)(\s*(?:😼|😸|😹|😻|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])?)\s*$/u;

/**
 * 「喵」口癖抑制器:一波回复里句尾喵太密时稀释到约一半。
 *   - 短促句(核心≤4 字,如「对对对喵」「确实喵」)一律去喵 —— tone.md「越短越不用带」。
 *   - 其余带喵句隔一个去一个,整体压到 ~50%。
 *   - 核心为空的纯「喵」/「喵~」保留(是句完整发言,不动)。
 * 确定性(按出现序,不用随机)→ 可单测。
 */
export function thinMeowTic(segments: string[]): string[] {
  let meowSeen = 0;
  return segments.map((seg) => {
    const m = seg.match(MEOW_TAIL);
    if (!m) return seg;
    const core = (m[1] ?? '').trim();
    if (!core) return seg; // 纯「喵」不动
    meowSeen++;
    const coreLen = [...core.replace(/[\s\p{P}]/gu, '')].length;
    const strip = coreLen <= 4 || meowSeen % 2 === 0; // 短句必去 + 其余隔一去一
    if (!strip) return seg;
    return (core + (m[3] ?? '') + (m[4] ?? '')).trimEnd();
  });
}

// ─── Kaomoji regex ───
// Matches bracket-wrapped emoticons (must contain non-alnum non-CJK non-space)
// and standalone kaomoji sequences (2-15 chars of common kaomoji characters)

const KAOMOJI_PATTERN = new RegExp(
  [
    // Bracketed: (^_^), （～￣▽￣）, etc.
    String.raw`[(\[（【]`,
    String.raw`[^()[\]（）【】]*?`,
    String.raw`[^一-龥a-zA-Z0-9\s]`,
    String.raw`[^()[\]（）【】]*?`,
    String.raw`[)\]）】]`,
    String.raw`|`,
    // Standalone: 2-15 kaomoji chars
    String.raw`([▼▽・ᴥω･﹏^><≧≦￣｀´∀ヮДд︿﹀へ｡ﾟ╥╯╰︶︹•⁄◡╹☉☼ε⊙◇♡♥❤☆★∞~≈≠§℃°∀∃←→↑↓↗↘↙↖─━│┃┆┇┊┋╭╮╯╰〕〈〉《》「」『』【】〔〕〖〗〘〙〚〛∘♪♫♬♩∠⊥△▽▾◇○◐◑◔◕▩▣☺☻☜☞☝✌✓✔✕✖✗✘✙✚✛✜✝✞✟✠✡✢✣✤✥✦✧✨✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆❇❈❉❊❋]{2,15})`,
  ].join(''),
  'g',
);

/**
 * Replace kaomoji with placeholders to protect them from splitting.
 * Returns the protected text and a mapping from placeholder → original kaomoji.
 */
function protectKaomoji(text: string): { text: string; mapping: Map<string, string> } {
  const mapping = new Map<string, string>();
  let result = text;
  let idx = 0;

  // Reset regex lastIndex
  KAOMOJI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KAOMOJI_PATTERN.exec(text)) !== null) {
    const kaomoji = match[0];
    const placeholder = `__KAOMOJI_${idx}__`;
    result = result.replace(kaomoji, placeholder);
    mapping.set(placeholder, kaomoji);
    idx++;
  }
  return { text: result, mapping };
}

/**
 * Recover kaomoji placeholders back to original strings.
 */
function recoverKaomoji(segments: string[], mapping: Map<string, string>): string[] {
  return segments.map((seg) => {
    let s = seg;
    mapping.forEach((original, placeholder) => {
      s = s.replace(placeholder, original);
    });
    return s;
  });
}

/**
 * Detect if a character is a CJK ideograph.
 */
function isCJK(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
}

/**
 * Get the ratio of Western (Latin) characters in text.
 */
function getWesternRatio(text: string): number {
  let western = 0;
  let total = 0;
  for (const char of text) {
    total++;
    if (/[a-zA-Z]/.test(char)) western++;
  }
  return total > 0 ? western / total : 0;
}

// ─── Quote-pair tracking ───

const QUOTE_PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['《', '》'],
  ['（', '）'],
  ['(', ')'],
  ['[', ']'],
];

function getMatchingCloseQuote(open: string): string | null {
  for (const [o, _c] of QUOTE_PAIRS) {
    if (o === open) return _c;
  }
  return null;
}

function isOpenQuote(char: string): boolean {
  return QUOTE_PAIRS.some(([o]) => o === char);
}

function isCloseQuote(char: string): boolean {
  return QUOTE_PAIRS.some(([, c]) => c === char);
}

// ─── Random punctuation removal ───

/**
 * Randomly process punctuation to simulate human typing habits.
 * - 90% chance to remove trailing 。(period)
 * - 5% chance to delete ，(comma)
 * - 20% chance to replace ，(comma) with a space
 */
function randomRemovePunctuation(text: string, periodDropRate = 0.9): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '。' && i === text.length - 1) {
      if (Math.random() < periodDropRate) continue; // 按群习惯去句尾句号
    } else if (char === '，') {
      const rand = Math.random();
      if (rand < 0.05) continue; // 5% delete comma
      else if (rand < 0.25) {
        result += ' '; // 20% replace comma with space
        continue;
      }
    }
    result += char;
  }
  return result;
}

// ─── Core splitting ───

const SPLIT_CHARS = new Set(['，', ',', '。', ';', '；']);
const SPACE_CHARS = new Set([' ', '\n']);

interface Segment {
  content: string;
  separator: string;
}

/**
 * Split text into natural sentence segments (MaiBot-style).
 *
 * Split points: ，, 。
 * Does NOT split at:
 * - Inside matching quote pairs
 * - Adjacent to colons (：:)
 * - Between alphanumeric characters bridged by spaces
 * - Inside kaomoji (protected before calling)
 *
 * After splitting, segments are probabilistically merged back:
 * - Short text (<12 chars): 80% merge probability (rarely split)
 * - Medium text (12-31 chars): 40% merge probability
 * - Long text (≥32 chars): 30% merge probability
 */
function splitIntoSentences(text: string): string[] {
  const len = text.length;
  if (len === 0) return [];

  const segments: Segment[] = [];
  let currentSegment = '';
  let quoteStack: string[] = []; // Track open quotes

  let i = 0;
  while (i < len) {
    const char = text[i]!;

    // Check quote pairs
    if (isOpenQuote(char)) {
      quoteStack.push(char);
      currentSegment += char;
      i++;
      continue;
    }
    if (isCloseQuote(char) && quoteStack.length > 0) {
      const lastOpen = quoteStack[quoteStack.length - 1]!;
      const expectedClose = getMatchingCloseQuote(lastOpen);
      if (expectedClose === char) {
        quoteStack.pop();
        currentSegment += char;
        i++;
        continue;
      }
    }

    // Inside quotes — don't split
    if (quoteStack.length > 0) {
      currentSegment += char;
      i++;
      continue;
    }

    // Colon protection: don't split around ：or :
    if (char === '：' || char === ':') {
      currentSegment += char;
      i++;
      // Don't split right after colon
      continue;
    }

    // Check if we should split at this character
    let canSplit = false;

    if (SPLIT_CHARS.has(char!)) {
      canSplit = true;
    } else if (SPACE_CHARS.has(char!)) {
      // Only split at spaces if not between alphanumeric characters
      const prevChar = i > 0 ? text[i - 1]! : '';
      const nextChar = i + 1 < len ? text[i + 1]! : '';

      if (char === '\n') {
        // Newlines always force a split (outside quotes)
        canSplit = true;
      } else if (prevChar && nextChar) {
        // Don't split "iPhone 15" or "hello world" if both neighbors are alphanumeric
        const prevIsAlphaNum = /[a-zA-Z0-9]/.test(prevChar);
        const nextIsAlphaNum = /[a-zA-Z0-9]/.test(nextChar);
        if (prevIsAlphaNum && nextIsAlphaNum) {
          canSplit = false;
        } else {
          canSplit = true;
        }
      } else {
        canSplit = false;
      }
    }

    if (canSplit) {
      if (currentSegment) {
        segments.push({ content: currentSegment, separator: char! });
      } else if (SPACE_CHARS.has(char!)) {
        segments.push({ content: '', separator: char! });
      }
      currentSegment = '';
    } else {
      currentSegment += char;
    }
    i++;
  }

  // Add last segment (no trailing separator)
  if (currentSegment) {
    segments.push({ content: currentSegment, separator: '' });
  }

  // Filter empty segments
  const filtered = segments.filter((s) => s.content || s.separator);
  if (filtered.length === 0) return [text];

  // Probabilistic merging
  let mergeProbability: number;
  if (len < 12) mergeProbability = 0.8;
  else if (len < 32) mergeProbability = 0.4;
  else mergeProbability = 0.3;

  const merged: Segment[] = [];
  let idx = 0;
  while (idx < filtered.length) {
    const seg = filtered[idx]!;
    const { content, separator } = seg;
    if (
      idx + 1 < filtered.length &&
      content &&
      separator !== '\n' &&
      Math.random() < mergeProbability
    ) {
      const next = filtered[idx + 1]!;
      if (next.content) {
        merged.push({ content: content + separator + next.content, separator: next.separator });
      } else {
        merged.push({ content, separator: next.separator });
      }
      idx += 2;
    } else {
      merged.push({ content, separator });
      idx += 1;
    }
  }

  // Extract final sentence content, normalize whitespace
  let finalSentences = merged
    .map((s) => s.content)
    .filter((s) => s.trim())
    .map((s) => s.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, ' ').trim());

  if (finalSentences.length === 0) finalSentences = [text];
  return finalSentences;
}

// ─── Main entry ───

export interface SegmentedReply {
  segments: string[];
  originalText: string;
}

/**
 * Process an LLM reply text into natural chat bubble segments.
 *
 * Pipeline:
 * 1. Trim whitespace
 * 2. Protect kaomoji (replace with placeholders)
 * 3. Strip bracket-wrapped Chinese content (小声) etc.
 * 4. Length check (too long → fallback)
 * 5. Split into sentences
 * 6. Random punctuation removal (human-like)
 * 7. Recover kaomoji
 * 8. Enforce max sentence count
 *
 * @param text Raw LLM reply text
 * @param config Override default config
 * @returns Segmented parts ready for sending as separate messages
 */
export function segmentReply(text: string, config?: Partial<SegmenterConfig>): SegmentedReply {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    const trimmed = text.trim();
    return { segments: trimmed ? [trimmed] : [cfg.defaultReply], originalText: text };
  }

  let processed = text.trim();
  if (!processed) {
    return { segments: [cfg.defaultReply], originalText: text };
  }

  // 1. Protect kaomoji
  let kaomojiMapping = new Map<string, string>();
  if (cfg.enableKaomojiProtection) {
    const protected_ = protectKaomoji(processed);
    processed = protected_.text;
    kaomojiMapping = protected_.mapping;
  }

  // 2. Strip bracket-wrapped Chinese content (whispers, asides)
  const bracketPattern = /[(\[（【](?=[^)\]）】]*[一-龥])[^)\]）】]*[)\]）】]/g;
  processed = processed.replace(bracketPattern, '');

  // 3. Length check
  const maxLengthDoubled = cfg.maxLength * 2;
  if (getWesternRatio(processed) < 0.1 && processed.length > maxLengthDoubled) {
    logger.warn({ length: processed.length, max: maxLengthDoubled }, 'Reply too long, using fallback');
    return { segments: [cfg.defaultReply], originalText: text };
  }

  // 4. Split
  let sentences = splitIntoSentences(processed);

  // 5. Random punctuation removal on each sentence
  sentences = sentences.map((s) => randomRemovePunctuation(s, cfg.periodDropRate));

  // 6. Recover kaomoji
  if (kaomojiMapping.size > 0) {
    sentences = recoverKaomoji(sentences, kaomojiMapping);
  }

  // 7. Max sentence count check
  if (sentences.length > cfg.maxSentenceNum) {
    if (cfg.enableOverflowReturnAll) {
      logger.warn({ count: sentences.length }, 'Too many segments, returning full text');
      sentences = [text.trim()];
    } else {
      return { segments: [cfg.defaultReply], originalText: text };
    }
  }

  // 8. Final filter (remove empty)
  let final = sentences.filter((s) => s.trim());
  if (final.length === 0) {
    return { segments: [cfg.defaultReply], originalText: text };
  }

  // 9. 「喵」口癖抑制(过密时稀释到约一半)
  if (cfg.thinMeow) {
    final = thinMeowTic(final).filter((s) => s.trim());
    if (final.length === 0) {
      return { segments: [cfg.defaultReply], originalText: text };
    }
  }

  return { segments: final, originalText: text };
}

/**
 * Calculate typing delay (in seconds) for a message segment.
 * Used to simulate human-like typing between message bubbles.
 */
export function calculateTypingDelay(text: string, config?: Partial<SegmenterConfig>): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let totalMs = 0;

  for (const char of text) {
    if (isCJK(char)) {
      totalMs += cfg.typingChineseTime * 1000;
    } else {
      totalMs += cfg.typingEnglishTime * 1000;
    }
  }

  // Single CJK char special case: triple it
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCJK(text[i]!)) cjkCount++;
  }
  if (cjkCount === 1 && text.trim().length === 1) {
    totalMs = cfg.typingChineseTime * 3 * 1000;
  }

  // Add "enter" time
  totalMs += 300;

  // Clamp
  return Math.max(cfg.typingMinDelay, Math.min(cfg.typingMaxDelay, totalMs / 1000));
}

/**
 * Convert ReplyOutput into segmented messages.
 * If the reply has multiple parsed parts (AI already output array),
 * keep them as-is. Otherwise, apply segmenter to split single long replies.
 *
 * @param replyContent The text content from AI
 * @param targetMessageId Which message to quote-reply
 * @param config Segmenter config override
 * @returns Array of { text, replyToId, isLast } for sequential sending
 */
export function planSegmentedSend(
  replyContent: string,
  targetMessageId: number,
  config?: Partial<SegmenterConfig>,
): Array<{ text: string; replyToId: number | undefined; isLast: boolean }> {
  const { segments } = segmentReply(replyContent, config);
  const result: Array<{ text: string; replyToId: number | undefined; isLast: boolean }> = [];

  for (let i = 0; i < segments.length; i++) {
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    const cfg = { ...DEFAULT_CONFIG, ...config };

    result.push({
      text: segments[i]!,
      replyToId: isFirst && cfg.firstMessageQuoteReply ? targetMessageId : undefined,
      isLast,
    });
  }

  return result;
}