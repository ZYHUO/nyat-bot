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

/** 某用户最熟的人(按边权): 返回对方名字,找不到返回 undefined。 */
export function getClosestPeer(chatId: number, uid: number): string | undefined {
  let rows: Array<{ uid_a: number; uid_b: number; name_a: string; name_b: string; weight: number; last_at: number }>;
  try {
    rows = getDb().prepare(
      'SELECT uid_a, uid_b, name_a, name_b, weight, last_at FROM social_edges WHERE chat_id = ? AND (uid_a = ? OR uid_b = ?)',
    ).all(chatId, uid, uid) as typeof rows;
  } catch { return undefined; }
  const t = now();
  let best: string | undefined;
  let bestW = EDGE_FLOOR;
  for (const r of rows) {
    const w = r.weight * Math.pow(DECAY_PER_DAY, Math.max(0, (t - r.last_at) / 86400));
    if (w < bestW) continue;
    const peer = r.uid_a === uid ? r.name_b : r.name_a;
    if (!peer) continue;
    bestW = w; best = peer;
  }
  return best;
}

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

/**
 * Phase 14.2 群牵线: 把"共同点"递给写手当可选素材,不是指令。
 * - 有共同往事(episode 命中): 提示提一句,像老群友翻旧账;无关则 buildSocialInjection 原样。
 * - 无往事但有共同熟人(getClosestPeer 双方同属一人): 提示顺带 cue 一下那个人。
 * 返回 '' = 没素材,调用方跳过(行为零变化)。
 * 只读同步调用(<1ms),flag 由调用方判定。
 */
export function buildBridgeHint(
  chatId: number,
  speakerUid: number,
  speakerName: string,
  messageText: string,
  recallFn: (chatId: number, text: string, limit: number) => Array<{ summary: string }>,
): string {
  if (messageText && messageText.length >= 4) {
    try {
      const eps = recallFn(chatId, messageText, 1);
      if (eps.length > 0 && eps[0]) {
        return `[牵线] 你们之前有过这事: ${eps[0].summary.slice(0, 80)}。顺嘴提一句就行,别展开讲课。`;
      }
    } catch { /* 无往事则看共同熟人 */ }
  }
  try {
    const peer = getClosestPeer(chatId, speakerUid);
    if (peer && peer !== speakerName) {
      return `[牵线] ${peer} 跟 ${speakerName} 平时走得近,自然的话可以顺带 cue 一下 ${peer}(比如"这事 ${peer} 肯定有话说"),别硬转。`;
    }
  } catch { /* non-critical */ }
  return '';
}
