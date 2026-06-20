// ────────────────────────────────────────
// Cross-group person identity — 借鉴 CGM 两层人物模型
// ────────────────────────────────────────
//
// per-(chat,uid) user_profiles = 群内画像;person_identity = 跨群身份。
// 让 bot 在 B 群也认得在 A 群熟的人(「跟我聊的始终是同一个人」),并给跨群好感 DM
// 一份一致的整体印象。刷新廉价确定性:取好感最高的群(primary)的画像作跨群印象。
//
// 热路径只做**同步读**(prompt 组装保持同步);缺失/陈旧时 fire-and-forget 异步刷新,
// 本回合用现有行,下回合即新鲜。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getUserGroups } from '../pipeline/context/manager.js';
import { getAggregatedAffinity } from './user-affinity.js';
import { getUserProfilePrompt } from './user-profile.js';

const STALE_SEC = 6 * 3600;

export interface PersonIdentityRow {
  uid: number;
  impression: string | null;
  primary_chat_id: number | null;
  chat_count: number;
  updated_at: number;
}

export function getPersonIdentity(uid: number): PersonIdentityRow | null {
  try {
    return (getDb().prepare('SELECT * FROM person_identity WHERE uid = ?').get(uid) as PersonIdentityRow | undefined) ?? null;
  } catch {
    return null;
  }
}

// In-flight dedup:同一个 uid 在刷新进行中(getUserGroups 的 Redis 往返窗口内)不重复刷,
// 避免连发用户在该窗口里 spawn N 个并发刷新。
const _refreshing = new Set<number>();

function upsertIdentity(uid: number, impression: string | null, primary: number | null, chatCount: number, now: number): void {
  getDb().prepare(
    `INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       impression = excluded.impression,
       primary_chat_id = excluded.primary_chat_id,
       chat_count = excluded.chat_count,
       updated_at = excluded.updated_at`,
  ).run(uid, impression, primary, chatCount, now);
}

/**
 * Recompute the cross-group impression from the person's groups.
 * Deterministic + cheap: primary = highest-affinity group, its profile = the cross-group impression.
 * 单群用户也写一行 tombstone(impression=null)——这样 updated_at 推进,stale 闸才能把刷新
 * 节流到每 STALE_SEC 一次,否则单群用户(最常见)会每条回复都白刷一次 Redis+SQLite。
 */
export async function refreshPersonIdentity(uid: number): Promise<PersonIdentityRow | null> {
  if (!uid || _refreshing.has(uid)) return getPersonIdentity(uid);
  _refreshing.add(uid);
  try {
    const groups = await getUserGroups(uid).catch(() => [] as number[]);
    const now = Math.floor(Date.now() / 1000);
    if (groups.length <= 1) {
      // tombstone:更新时间戳以节流;impression=null → buildCrossGroupInjection 返回 null
      upsertIdentity(uid, null, null, groups.length, now);
      return { uid, impression: null, primary_chat_id: null, chat_count: groups.length, updated_at: now };
    }
    const agg = getAggregatedAffinity(uid);
    const primary = agg.primaryChatId ?? groups[0]!;
    const impression = getUserProfilePrompt(primary, uid);
    upsertIdentity(uid, impression, primary, groups.length, now);
    return { uid, impression, primary_chat_id: primary, chat_count: groups.length, updated_at: now };
  } catch (err) {
    logger.debug({ err, uid }, 'refreshPersonIdentity failed (non-critical)');
    return null;
  } finally {
    _refreshing.delete(uid);
  }
}

/**
 * SYNC prompt block: the bot's cross-group sense of this person — only when known from OTHER
 * groups (the current group already has its own per-group profile). Lazy fire-and-forget refresh
 * when missing/stale; never blocks prompt assembly.
 */
export function buildCrossGroupInjection(uid: number, currentChatId: number): string | null {
  if (!env().PERSON_IDENTITY_ENABLED || !uid) return null;
  const row = getPersonIdentity(uid);
  const now = Math.floor(Date.now() / 1000);
  if (!row || now - row.updated_at > STALE_SEC) {
    void refreshPersonIdentity(uid).catch(() => { /* fire-and-forget */ });
  }
  if (!row || !row.impression) return null;
  if (row.chat_count <= 1) return null;
  if (row.primary_chat_id === currentChatId) return null; // 当前群即主群 → 群内画像已覆盖,不重复
  return `[这个人你在别的群也认识] 你和 TA 在 ${row.chat_count} 个群有交集。你对 TA 的整体印象(跨群):\n${row.impression.slice(0, 400)}`;
}
