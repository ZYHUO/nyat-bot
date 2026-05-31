// ────────────────────────────────────────
// Inter-user social graph — who interacts with whom in a group.
// Models member↔member ties (reply chains / @s), separate from the bot↔user
// affinity/mood/reputation. Edge weight decays over time; the top ties are
// injected into the reply prompt so the cat-girl can read the room.
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';

const DECAY_PER_DAY = 0.97; // tunable — ~3%/day decay (half-life ~23 days)
const EDGE_FLOOR = 2;       // tunable — ignore one-off interactions
const NAME_MAX = 16;
const TOP_N = 4;            // tunable — how many ties to surface

function now(): number { return Math.floor(Date.now() / 1000); }
function clip(s: string): string { return (s || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); }

/**
 * Record that `from` interacted with `to` (a reply or @-mention). Canonical
 * ordering (uid_a < uid_b) so A→B and B→A share one edge. Fire-and-forget; sync.
 */
export function recordInteraction(
  chatId: number, fromUid: number, fromName: string, toUid: number, toName: string,
): void {
  if (!fromUid || !toUid || fromUid === toUid) return;
  const [a, an, b, bn] = fromUid < toUid
    ? [fromUid, clip(fromName), toUid, clip(toName)]
    : [toUid, clip(toName), fromUid, clip(fromName)];
  const t = now();
  try {
    getDb().prepare(`
      INSERT INTO social_edges (chat_id, uid_a, uid_b, name_a, name_b, weight, last_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(chat_id, uid_a, uid_b) DO UPDATE SET
        weight  = weight + 1,
        last_at = excluded.last_at,
        name_a  = CASE WHEN excluded.name_a != '' THEN excluded.name_a ELSE name_a END,
        name_b  = CASE WHEN excluded.name_b != '' THEN excluded.name_b ELSE name_b END
    `).run(chatId, a, b, an, bn, t);
  } catch { /* non-critical */ }
}

export interface SocialEdge { nameA: string; nameB: string; weight: number }

/** Top decayed edges for a chat (strongest current ties). */
export function getTopEdges(chatId: number, limit = TOP_N): SocialEdge[] {
  let rows: Array<{ name_a: string; name_b: string; weight: number; last_at: number }>;
  try {
    rows = getDb().prepare(
      'SELECT name_a, name_b, weight, last_at FROM social_edges WHERE chat_id = ?',
    ).all(chatId) as typeof rows;
  } catch { return []; }
  const t = now();
  return rows
    .map((r) => ({
      nameA: r.name_a,
      nameB: r.name_b,
      weight: r.weight * Math.pow(DECAY_PER_DAY, Math.max(0, (t - r.last_at) / 86400)),
    }))
    .filter((e) => e.weight >= EDGE_FLOOR && e.nameA && e.nameB)
    .sort((x, y) => y.weight - x.weight)
    .slice(0, limit);
}

/** Compact "[群友关系]" hint for the reply prompt, or '' if not enough signal. */
export function buildSocialInjection(chatId: number): string {
  const edges = getTopEdges(chatId);
  if (edges.length === 0) return '';
  return edges.map((e) => `${e.nameA} 和 ${e.nameB} 常互动`).join('；');
}
