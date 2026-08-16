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
import { getUserContexts } from '../pipeline/context/manager.js';
import { getAggregatedAffinity } from './user-affinity.js';
import { getUserProfilePrompt } from './user-profile.js';
import { isGroup } from '../shared/chat.js';
import { isPrivateChat } from '../memory/visibility.js';

const STALE_SEC = 6 * 3600;

export interface PersonIdentityRow {
  uid: number;
  impression: string | null;
  primary_chat_id: number | null;
  chat_count: number;
  updated_at: number;
  // 机制2 全局 PersonProfile 列(0047;由机制5 LLM 合并 cron 产出,可空)
  traits?: string | null;             // JSON string[]
  interests?: string | null;          // JSON string[]
  comm_style?: string | null;
  relation_to_bot?: string | null;
  stable_patterns?: string | null;    // JSON string[]
  source_context_ids?: string | null; // JSON number[]
  confidence?: number;
  last_merged_at?: number | null;
  // AGI L5 L6: 记忆陈旧标记(0064)—— stale=1 时 prompt 注明可能过时
  last_confirmed_at?: number | null;
  stale?: number;
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

// review #10:on-read 后台 LLM 合并的节流 —— refreshPersonIdentity 是 fire-and-forget
// 不 await,stale 窗口在 updated_at 写回前一直开着,busy chat 里该用户每条消息都会
// 再触发一次 mergeGlobalProfile(每次一发 LLM 调用)。这里按 uid 记最近触发时刻,
// MERGE_TRIGGER_COOLDOWN 内不重复触发。
const _mergeTriggeredAt = new Map<number, number>();
const MERGE_TRIGGER_COOLDOWN_SEC = 300;
// 无界增长兜底:正常时条目数≈活跃用户数,但长寿进程 + 大量一次性用户会缓慢堆积。
// 超过上限时先清掉冷却窗外的旧条目;若全在窗内(异常突发)直接清空——代价只是
// 允许一批 merge 重新触发,不会错合并。
const MERGE_TRIGGER_MAP_CAP = 10_000;

function shouldTriggerMerge(uid: number, nowSec: number): boolean {
  if (_mergeTriggeredAt.size > MERGE_TRIGGER_MAP_CAP) {
    for (const [k, ts] of _mergeTriggeredAt) {
      if (nowSec - ts >= MERGE_TRIGGER_COOLDOWN_SEC) _mergeTriggeredAt.delete(k);
    }
    if (_mergeTriggeredAt.size > MERGE_TRIGGER_MAP_CAP) _mergeTriggeredAt.clear();
  }
  const last = _mergeTriggeredAt.get(uid) ?? 0;
  if (nowSec - last < MERGE_TRIGGER_COOLDOWN_SEC) return false;
  _mergeTriggeredAt.set(uid, nowSec);
  return true;
}

/**
 * @param clearImpression tombstone 路径专用:显式把 impression 清成 NULL(绕过下面的
 *   COALESCE 保护)。普通刷新路径必须为 false —— impression 取不到时应保留旧值。
 */
function upsertIdentity(
  uid: number,
  impression: string | null,
  primary: number | null,
  chatCount: number,
  now: number,
  clearImpression = false,
): void {
  if (clearImpression) {
    getDb().prepare(
      `INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at)
       VALUES (?, NULL, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET
         impression = NULL,
         primary_chat_id = excluded.primary_chat_id,
         chat_count = excluded.chat_count,
         updated_at = excluded.updated_at`,
    ).run(uid, primary, chatCount, now);
    return;
  }
  getDb().prepare(
    `INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       -- COALESCE:primary 群的 user_profiles.profile_prompt 还没被每小时的画像 cron 填上
       -- (新活跃的群,或好感排序刚漂移换了 primary)时 impression 会是 NULL。无条件覆盖会
       -- 抹掉已积累的跨群印象,而 PROFILE_MERGE_ENABLED 默认关 → 全局结构化列是空 →
       -- buildCrossGroupInjection 里 "if (!row.impression) return null" 让跨群认人直接归零,
       -- 且要等 6h + 画像 cron 才恢复。真的要清空走 upsertIdentity 的 clearImpression=true。
       impression = COALESCE(excluded.impression, person_identity.impression),
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
    // 机制2:上下文 = 群 ∪ DM(不再只数群)。纯 DM / 单群但也私聊过的人
    // 也算 >1 上下文,能拿到跨上下文连结。
    const contexts = await getUserContexts(uid).catch(() => [] as number[]);
    const now = Math.floor(Date.now() / 1000);
    if (contexts.length <= 1) {
      // tombstone:更新时间戳以节流;impression=null → buildCrossGroupInjection 返回 null。
      // clearImpression=true 显式绕过 upsert 里的 COALESCE 保护 —— 这里的 NULL 是有意的。
      upsertIdentity(uid, null, null, contexts.length, now, true);
      return { uid, impression: null, primary_chat_id: null, chat_count: contexts.length, updated_at: now };
    }
    const agg = getAggregatedAffinity(uid);
    const primary = agg.primaryChatId ?? contexts[0]!;
    // impression 兜底仍取 primary 上下文画像;全局结构化列(traits/interests/…)
    // 由机制5 LLM 合并 cron 产出,这里保留已有值不覆盖。
    const impression = getUserProfilePrompt(primary, uid);
    upsertIdentity(uid, impression, primary, contexts.length, now);
    const existing = getPersonIdentity(uid);
    // impression 用**落库后**的值,不是本地变量 —— COALESCE 可能保留了旧值,返回本地的
    // null 会让调用方以为跨群印象没了。
    return { ...(existing ?? {} as PersonIdentityRow), uid, impression: existing?.impression ?? impression, primary_chat_id: primary, chat_count: contexts.length, updated_at: now };
  } catch (err) {
    logger.debug({ err, uid }, 'refreshPersonIdentity failed (non-critical)');
    return null;
  } finally {
    _refreshing.delete(uid);
  }
}

/** 机制2:结构化全局画像(解析 JSON 列)。 */
export interface GlobalProfile {
  traits: string[];
  interests: string[];
  commStyle: string;
  relationToBot: string;
  stablePatterns: string[];
  sourceContextIds: number[];
  confidence: number;
  lastMergedAt: number | null;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function getGlobalProfile(uid: number): GlobalProfile | null {
  const row = getPersonIdentity(uid);
  if (!row) return null;
  return {
    traits: parseJsonArray<string>(row.traits),
    interests: parseJsonArray<string>(row.interests),
    commStyle: row.comm_style ?? '',
    relationToBot: row.relation_to_bot ?? '',
    stablePatterns: parseJsonArray<string>(row.stable_patterns),
    sourceContextIds: parseJsonArray<number>(row.source_context_ids),
    confidence: row.confidence ?? 0,
    lastMergedAt: row.last_merged_at ?? null,
  };
}

/**
 * 机制5:写回 LLM 合并出的全局画像列(**成功才更新 last_merged_at**)。
 * 只更新全局结构化列,不动 impression/primary_chat_id/chat_count(那些由 refresh 维护)。
 * 若该 uid 尚无行,先建一行(chat_count 由后续 refresh 校正)。
 */
export function setGlobalProfile(uid: number, p: {
  traits: string[];
  interests: string[];
  commStyle: string;
  relationToBot: string;
  stablePatterns: string[];
  sourceContextIds: number[];
  confidence: number;
}): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    `INSERT INTO person_identity (uid, chat_count, updated_at, traits, interests, comm_style, relation_to_bot, stable_patterns, source_context_ids, confidence, last_merged_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       traits = excluded.traits,
       interests = excluded.interests,
       comm_style = excluded.comm_style,
       relation_to_bot = excluded.relation_to_bot,
       stable_patterns = excluded.stable_patterns,
       source_context_ids = excluded.source_context_ids,
       confidence = excluded.confidence,
       last_merged_at = excluded.last_merged_at`,
  ).run(
    uid, now,
    JSON.stringify(p.traits ?? []),
    JSON.stringify(p.interests ?? []),
    p.commStyle ?? '',
    p.relationToBot ?? '',
    JSON.stringify(p.stablePatterns ?? []),
    JSON.stringify(p.sourceContextIds ?? []),
    Math.max(0, Math.min(1, p.confidence ?? 0)),
    now,
  );
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
    // 机制5:全局画像久未合并且开了合并 → 后台补一次 LLM 合并(dynamic import 防循环)。
    // review #10:加 in-flight 节流,否则 stale 窗口内该用户每条消息都 spawn 一次 LLM 合并。
    if (env().PROFILE_MERGE_ENABLED && (!row?.last_merged_at || now - row.last_merged_at > STALE_SEC) && shouldTriggerMerge(uid, now)) {
      void import('../cron/profile-merge.js')
        .then(({ mergeGlobalProfile }) => mergeGlobalProfile(uid))
        .catch(() => { /* fire-and-forget */ });
    }
  }
  // 机制3:上下文数(含 DM)≤1 不注入(chat_count 现为"上下文数")。
  if (!row || row.chat_count <= 1) return null;
  // review #8:当前会话即主上下文 → 群内画像已覆盖,全局/回退两路都不重复注入
  // (旧 dedup 守卫曾被全局分支跳过,导致在 home 群也注入"别的地方也认识")。
  if (row.primary_chat_id === currentChatId) return null;

  // 机制2/3 优先:全局结构化画像(LLM 合并产出)。合并 prompt 已排除私聊具体隐私
  // (safe-by-construction,残余风险=LLM 自觉)。review #2:把这条**跨上下文共享**
  // 路径与隐私开关耦合 —— 注入进群且全局画像含私密来源时,要求 MEMORY_VISIBILITY_ENABLED
  // 已开(运维已进入隐私感知模式);否则退回下方按来源 scrub 的 impression 路,不裸注
  // 可能含 DM 提炼物的全局画像进群。
  const g = getGlobalProfile(uid);
  if (g && g.lastMergedAt && (g.traits.length || g.interests.length || g.relationToBot)) {
    const derivedFromPrivate = g.sourceContextIds.some((c) => isPrivateChat(c));
    const okToInject = !isGroup(currentChatId) || !derivedFromPrivate || env().MEMORY_VISIBILITY_ENABLED;
    if (okToInject) {
      const bits: string[] = [];
      if (g.traits.length) bits.push(`性格:${g.traits.slice(0, 6).join('、')}`);
      if (g.interests.length) bits.push(`兴趣:${g.interests.slice(0, 6).join('、')}`);
      if (g.commStyle) bits.push(`说话:${g.commStyle}`);
      if (g.relationToBot) bits.push(`和你的关系:${g.relationToBot}`);
      if (g.stablePatterns.length) bits.push(`习惯:${g.stablePatterns.slice(0, 4).join('、')}`);
      return `[这个人你在别的地方也认识] 跨 ${row.chat_count} 个场景对 TA 的整体印象:\n${bits.join(';')}`;
    }
  }

  // 回退:primary 上下文的原始画像摘要。**scrub-on-inject**(review #9:不限
  // 群目标)——只要该摘要来自私密会话(DM/敏感群)且非当前会话,无论注入目标是
  // 群还是私聊,一律剔除(敏感群内容也不该在别处裸泄;DM 内容不该进群)。
  if (!row.impression) return null;
  if (
    row.primary_chat_id !== null &&
    isPrivateChat(row.primary_chat_id)
  ) {
    return null; // 群里不注入来自私聊/敏感会话的原始画像(等 LLM 合并出安全的全局画像再注)
  }
  return `[这个人你在别的地方也认识] 你和 TA 在 ${row.chat_count} 个场景有交集。你对 TA 的整体印象:\n${row.impression.slice(0, 400)}`;
}
