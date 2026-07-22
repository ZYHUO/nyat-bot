// Soft truncate for CodeAct / chat replies — CJK-aware (no mid-hanzi / mid-word clip).

const CJK_CHAR =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function isBreakChar(ch: string): boolean {
  if (!ch) return false;
  if (/\s/.test(ch)) return true;
  // Prefer ending on sentence/clause punctuation
  if (/[。！？!?；;，,、…—\-~～]/.test(ch)) return true;
  // Latin word boundary
  if (/[^A-Za-z0-9_]/.test(ch) && !CJK_CHAR.test(ch)) return true;
  return false;
}

/**
 * Truncate to maxLen code units, preferring a nearby break.
 * For CJK-heavy text, cut at punctuation or between characters (never mid-surrogate).
 */
export function softTruncate(text: string, maxLen: number): string {
  const raw = String(text ?? '').trim();
  if (!raw || maxLen <= 0) return '';
  if (raw.length <= maxLen) return raw;

  const budget = Math.max(1, maxLen);
  let slice = raw.slice(0, budget);
  // Avoid splitting surrogate pairs
  if (slice.length < raw.length) {
    const last = slice.charCodeAt(slice.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
  }

  const cjkCount = (slice.match(new RegExp(CJK_CHAR.source, 'g')) ?? []).length;
  const cjkHeavy = cjkCount >= slice.length * 0.3;

  // Search backward for a good break within a window
  const window = Math.min(40, Math.floor(slice.length * 0.35));
  const minKeep = Math.max(1, slice.length - window);
  for (let i = slice.length - 1; i >= minKeep; i--) {
    const ch = slice[i]!;
    if (cjkHeavy) {
      if (/[。！？!?；;…]/.test(ch)) return slice.slice(0, i + 1);
      if (/[，,、]/.test(ch) && i >= slice.length - 12) return slice.slice(0, i + 1);
    } else if (isBreakChar(ch)) {
      const cut = /\s/.test(ch) ? i : i + 1;
      if (cut >= minKeep) return slice.slice(0, cut).trimEnd();
    }
  }

  // CJK: cutting between characters is OK; Latin: trim dangling partial word
  if (!cjkHeavy) {
    const m = slice.match(/^(.*\b)\W*\w*$/);
    if (m?.[1] && m[1].length >= minKeep) return m[1].trimEnd();
  }
  return slice.trimEnd();
}
