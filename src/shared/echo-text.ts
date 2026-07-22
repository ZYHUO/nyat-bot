/** Normalize for near-duplicate / echo checks. */
export function normalizeEchoText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、…~～!?,.]+/g, '')
    .replace(/(喵)+$/g, '');
}

/** Drop leading discourse fluff so「你先看…」vs「先看…」still match. */
export function stripEchoLeadIn(s: string): string {
  return s.replace(/^[你我他她它咱俺先再就也那]+/u, '');
}

function charBigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Jaccard over character bigrams (Chinese paraphrase / near-dup). */
export function bigramOverlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = charBigrams(a);
  const B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

/**
 * True when `reply` is essentially the same as `source` (copy / slight trim /
 * light paraphrase). Short strings need near-exact match; longer ones allow
 * containment or high bigram overlap.
 */
export function isEchoOf(reply: string, source: string): boolean {
  const rawA = normalizeEchoText(reply);
  const rawB = normalizeEchoText(source);
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;

  const a = stripEchoLeadIn(rawA);
  const b = stripEchoLeadIn(rawB);
  if (a && b && a === b) return true;

  const minLen = Math.min(a.length || rawA.length, b.length || rawB.length);
  const maxLen = Math.max(a.length || rawA.length, b.length || rawB.length);
  if (minLen < 4) return false;

  const left = a || rawA;
  const right = b || rawB;
  if (maxLen >= 6 && (left.includes(right) || right.includes(left))) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length) >= 0.72;
  }
  // Paraphrase:「别真给烤熟了」vs「别真把小机子给烤熟了」
  if (minLen >= 10 && bigramOverlapRatio(left, right) >= 0.72) return true;
  return false;
}
