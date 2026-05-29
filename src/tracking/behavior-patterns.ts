// ────────────────────────────────────────
// Behavior pattern lexicons — deterministic early-exit signals
// Used by ReplyOutcomeTracker to finalize a pending reply immediately
// when the user explicitly reacts (negative / repair / positive),
// instead of waiting for the ignore window.
// ────────────────────────────────────────

/** User explicitly signals the bot's reply was wrong / unwanted / confusing. */
export const NEGATIVE_PATTERNS: string[] = [
  '没懂',
  '不对',
  '你理解错',
  '看不懂',
  '听不懂',
  '错了',
  '无语',
  '离谱',
  '答非所问',
  '牛头不对马嘴',
  '胡说',
  '瞎说',
];

/** User is correcting/restating because the bot misunderstood (repair loop). */
export const REPAIR_PATTERNS: string[] = [
  '我是说',
  '我说的是',
  '你理解错',
  '你搞错',
  '不是这个意思',
  '纠正',
  '我意思是',
  '不是说',
];

/** User explicitly signals the bot's reply was good / understood / useful. */
export const POSITIVE_PATTERNS: string[] = [
  '谢谢',
  '懂了',
  '可以',
  '有用',
  '不错',
  '明白了',
  '对的',
  '没错',
  '学到了',
  '太好了',
];

/**
 * Count how many of `patterns` appear as substrings of `text`.
 * Case-insensitive (CJK is unaffected; helps for any latin patterns).
 */
export function countMatches(text: string, patterns: string[]): number {
  if (!text) return 0;
  const haystack = text.toLowerCase();
  let n = 0;
  for (const p of patterns) {
    if (p && haystack.includes(p.toLowerCase())) n++;
  }
  return n;
}
