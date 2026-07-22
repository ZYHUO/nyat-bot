/** Normalize for near-duplicate / echo checks. */
export function normalizeEchoText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、…~～!?,.]+/g, '')
    .replace(/(喵)+$/g, '');
}

/**
 * True when `reply` is essentially the same as `source` (copy / slight trim).
 * Short strings need near-exact match; longer ones allow containment with high ratio.
 */
export function isEchoOf(reply: string, source: string): boolean {
  const a = normalizeEchoText(reply);
  const b = normalizeEchoText(source);
  if (!a || !b) return false;
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (minLen < 4) return false;
  if (maxLen >= 6 && (a.includes(b) || b.includes(a))) {
    return minLen / maxLen >= 0.72;
  }
  return false;
}
