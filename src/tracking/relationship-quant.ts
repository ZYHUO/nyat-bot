// ────────────────────────────────────────
// #2 关系评分量化 (Quantified relationship scoring)
// ────────────────────────────────────────
//
// 移植自 CyberGroupmate memory-v2/reflection.ts (computeAffinityScores /
// trimProfileByTier / Dunbar caps),落到 nyat-bot 的真实 schema 上:
//
//   score = base(百分位/线性) + quality 增量 − 沉默衰减 (+DM 加成), clamp [0,100]
//     - base: 30 天窗口三维度加权 —— 互动次数 50% / 活跃天数 30% / 画像深度 20%。
//       ≥5 人群用百分位排名; <5 人(含 DM)退回相对中位数线性映射。
//     - quality: 现有关系事件流映射到 friendly +10 / dependent +15 /
//       instrumental 0 / hostile −20,累积在 quant_quality_pending 侧车列,
//       重算时一次性消费清零(单周期有效范围即一个 label 的量程)。
//     - 沉默衰减: >14 天无互动,每多一天 −2。
//     - DM (chatId > 0): base +15。
//   tier: ≥90 Tier1 / ≥70 Tier2 / ≥50 Tier3 / else Tier4。
//   Dunbar 容量 15/50/150: 超员的 tier 把分数最低者强制降级。
//
// 持久化: 全部写 chat_relationships 的 quant_* 侧车列 (migration 0069),
// affinity 列与 bucket 注入 (relationship.ts) 完全不动。
//
// 数据流:
//   recordUserMessage → recordRelationshipActivity (日活表, RELATIONSHIP_QUANT_ENABLED)
//   applyRelationshipEvent → accumulateQualityEvent (quality 侧车, 同 flag)
//   cron relationship-summarize → recomputeAllChats (评分+分层+落库)
//     → trimProfileByTier (画像裁剪, RELATIONSHIP_PROFILE_TRIM_ENABLED)
//
// 两个 flag 默认关,关闭时所有入口 no-op,行为与旧路径一致。全部 fail-soft。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export type QuantTier = 1 | 2 | 3 | 4;
export type InteractionQuality = 'friendly' | 'dependent' | 'instrumental' | 'hostile';

/** 30 天滚动窗口 */
const AFFINITY_WINDOW_DAYS = 30;
/** 超过此天数无互动则开始衰减 */
const DECAY_START_DAYS = 14;
/** 衰减系数 (每天减少的分数) */
const DECAY_PER_DAY = 2;
/** DM 加成 (私聊本身意味着更高亲密度) */
const DM_BONUS = 15;
/** 达到此人数用百分位排名,否则退回线性映射 */
const PERCENTILE_MIN_MEMBERS = 5;
/** 日活表保留天数 (略大于窗口,给重算留余量) */
const ACTIVITY_RETENTION_DAYS = 35;

const WEIGHT_INTERACTIONS = 0.5;
const WEIGHT_ACTIVE_DAYS = 0.3;
const WEIGHT_DEPTH = 0.2;

const QUALITY_DELTAS: Record<InteractionQuality, number> = {
  friendly: 10,
  dependent: 15,
  instrumental: 0,
  hostile: -20,
};
/** quality 累积的量程 = 单个 label 的 delta 范围 (一个重算周期至多一个有效 label)。 */
const QUALITY_PENDING_MIN = -20; // hostile
const QUALITY_PENDING_MAX = 15; // dependent

/** Dunbar 每层人数上限 (Tier4 无上限,是降级终点站)。 */
const DUNBAR_CAPS: Partial<Record<QuantTier, number>> = { 1: 15, 2: 50, 3: 150 };

/** 单个 Tier 的画像精度限制 (与 CGM DEFAULT_TIER_LIMITS 一致)。 */
export interface TierLimitEntry {
  maxTraits: number;
  maxInterests: number;
  episodeDays: number;
}
export const TIER_LIMITS: Record<QuantTier, TierLimitEntry> = {
  1: { maxTraits: 10, maxInterests: 15, episodeDays: 14 },
  2: { maxTraits: 6, maxInterests: 10, episodeDays: 7 },
  3: { maxTraits: 3, maxInterests: 5, episodeDays: 3 },
  4: { maxTraits: 1, maxInterests: 2, episodeDays: 1 },
};

// nyat-bot 画像没有 CGM 的 traits/interests/recentEpisodes 字段,映射到
// user_profile_sections 的分区: stable_facts ≈ traits (稳定特质),
// topics ≈ interests (领域标签), recent ≈ episodes (易变近况, 按 updated_at 过期)。
const TRAITS_SECTION = 'stable_facts';
const INTERESTS_SECTION = 'topics';
const EPISODES_SECTION = 'recent';

export interface QuantScore {
  score: number;
  tier: QuantTier;
}

/** 一个 chat 成员参与评分所需的全部输入 (纯数据,便于单测)。 */
export interface MemberStat {
  uid: number;
  /** 30 天窗口内消息数 */
  interactionCount: number;
  /** 30 天窗口内活跃天数 */
  activeDays: number;
  /** 画像深度 (全部分区 bullet 总数) */
  depth: number;
  /** 最后一次互动 (unix 秒); 无任何记录则 null */
  lastInteractionAt: number | null;
  /** 已持久化的上一周期分数 (零互动成员的衰减起点) */
  existingScore: number;
  /** 本周期累积的 quality 增量 */
  qualityDelta: number;
}

function clampScore(v: number): number {
  if (v > 100) return 100;
  if (v < 0) return 0;
  return v;
}

/** 计算百分位排名 (0-100)。sortedValues 必须升序。 */
export function percentileRank(value: number, sortedValues: number[]): number {
  if (sortedValues.length <= 1) return 50;
  let below = 0;
  for (const v of sortedValues) {
    if (v < value) below++;
  }
  return (below / (sortedValues.length - 1)) * 100;
}

/** 线性映射 (小群组 <5 人时用): 中位数 → 50, 两倍中位数 → 100 (封顶)。 */
export function linearMap(value: number, median: number): number {
  if (median <= 0) return value > 0 ? 50 : 0;
  return Math.min(100, (value / median) * 50);
}

export function scoreToTier(score: number): QuantTier {
  if (score >= 90) return 1;
  if (score >= 70) return 2;
  if (score >= 50) return 3;
  return 4;
}

/**
 * 现有关系事件 (applyRelationshipEvent 的 summary, 形如 "positive:user_replied")
 * 映射到 CGM 的 interaction quality。事件种类见 tracking/outcome.ts:
 *   positive:*                    → friendly (被接住/被感谢)
 *   negative:ignored              → instrumental (没接住 ≠ 敌对, 中性)
 *   negative:explicit_negative / negative:repair_loop → hostile
 * 未知种类一律 instrumental (0, 保守中性)。dependent 暂无来源事件,
 * 保留在映射表里给未来 LLM 质量判定用。
 */
export function mapRelationshipEventToQuality(summary: string): InteractionQuality {
  const s = summary.trim().toLowerCase();
  if (s.startsWith('positive:')) return 'friendly';
  if (s.startsWith('negative:explicit_negative') || s.startsWith('negative:repair_loop')) {
    return 'hostile';
  }
  return 'instrumental';
}

/** UTC 今日 (YYYY-MM-DD),与 daily_stats 同一天口径。 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

/**
 * 写侧: 每条人类消息记一次日活 (per chat/uid/day 计数 +1)。
 * 由 recordUserMessage 在 RELATIONSHIP_QUANT_ENABLED 时调用; 自身 fail-soft。
 */
export function recordRelationshipActivity(chatId: number, uid: number): void {
  if (!env().RELATIONSHIP_QUANT_ENABLED) return;
  if (uid <= 0) return;
  try {
    getDb()
      .prepare(
        `INSERT INTO relationship_activity_daily (chat_id, uid, date, msg_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(chat_id, uid, date) DO UPDATE SET msg_count = msg_count + 1`,
      )
      .run(chatId, uid, todayUtc());
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'recordRelationshipActivity failed (non-critical)');
  }
}

/**
 * 写侧: 把关系事件映射成 quality delta 累积到 quant_quality_pending (clamp
 * 到单 label 量程 [-20, +15]),下次 recompute 消费后清零。
 * 由 applyRelationshipEvent 在 upsert chat_relationships 之后调用 (行已存在);
 * 自身 fail-soft。
 */
export function accumulateQualityEvent(chatId: number, uid: number, summary: string): void {
  if (!env().RELATIONSHIP_QUANT_ENABLED) return;
  try {
    const delta = QUALITY_DELTAS[mapRelationshipEventToQuality(summary)];
    if (delta === 0) return;
    getDb()
      .prepare(
        `UPDATE chat_relationships
         SET quant_quality_pending = MIN(?, MAX(?, quant_quality_pending + ?))
         WHERE chat_id = ? AND uid = ?`,
      )
      .run(QUALITY_PENDING_MAX, QUALITY_PENDING_MIN, delta, chatId, uid);
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'accumulateQualityEvent failed (non-critical)');
  }
}

/**
 * 纯函数: 对一组成员计算量化分数与 tier (不含 Dunbar 降级)。
 * 移植 CGM computeAffinityScores; nowMs 可注入便于测试。
 */
export function computeQuantScores(
  members: MemberStat[],
  opts: { isDM: boolean; nowMs?: number },
): Map<number, QuantScore> {
  const result = new Map<number, QuantScore>();
  if (members.length === 0) return result;
  const nowMs = opts.nowMs ?? Date.now();

  const interactionCounts = members.map((m) => m.interactionCount).sort((a, b) => a - b);
  const activeDaysList = members.map((m) => m.activeDays).sort((a, b) => a - b);
  const depthValues = members.map((m) => m.depth).sort((a, b) => a - b);

  const usePercentile = members.length >= PERCENTILE_MIN_MEMBERS;
  // CGM 是 `sorted[i] || 1`: undefined 和 0 都归一为 1,保持同样语义。
  const medianInteractions = (interactionCounts[Math.floor(interactionCounts.length / 2)] ?? 0) || 1;
  const medianDays = (activeDaysList[Math.floor(activeDaysList.length / 2)] ?? 0) || 1;
  const medianDepth = (depthValues[Math.floor(depthValues.length / 2)] ?? 0) || 1;

  for (const m of members) {
    const daysSilent = m.lastInteractionAt
      ? (nowMs - m.lastInteractionAt * 1000) / 86400_000
      : AFFINITY_WINDOW_DAYS;
    const decay = Math.max(0, daysSilent - DECAY_START_DAYS) * DECAY_PER_DAY;

    // 30 天内零互动 → 不重算 base,只在原分上按时间衰减 (CGM 同款保底)。
    if (m.interactionCount === 0) {
      const finalScore = clampScore(m.existingScore - decay);
      result.set(m.uid, { score: finalScore, tier: scoreToTier(finalScore) });
      continue;
    }

    let baseScore: number;
    if (usePercentile) {
      const interP = percentileRank(m.interactionCount, interactionCounts);
      const dayP = percentileRank(m.activeDays, activeDaysList);
      const depthP = percentileRank(m.depth, depthValues);
      baseScore = interP * WEIGHT_INTERACTIONS + dayP * WEIGHT_ACTIVE_DAYS + depthP * WEIGHT_DEPTH;
    } else {
      const interL = linearMap(m.interactionCount, medianInteractions);
      const dayL = linearMap(m.activeDays, medianDays);
      const depthL = linearMap(m.depth, medianDepth);
      baseScore = interL * WEIGHT_INTERACTIONS + dayL * WEIGHT_ACTIVE_DAYS + depthL * WEIGHT_DEPTH;
    }

    if (opts.isDM) {
      baseScore = Math.min(100, baseScore + DM_BONUS);
    }

    const finalScore = clampScore(baseScore + m.qualityDelta - decay);
    result.set(m.uid, { score: finalScore, tier: scoreToTier(finalScore) });
  }

  return result;
}

/**
 * Dunbar 容量检查: tier 超员时按 (score, 互动数) 升序把最低者强制降到下一层
 * (Tier4 是终点站不再降)。直接修改传入的 map,返回被降级名单 (供日志/测试)。
 */
export function applyDunbarCaps(
  scores: Map<number, QuantScore>,
  members: MemberStat[],
): Array<{ uid: number; from: QuantTier; to: QuantTier }> {
  const demoted: Array<{ uid: number; from: QuantTier; to: QuantTier }> = [];
  const countOf = new Map<number, number>();
  for (const m of members) countOf.set(m.uid, m.interactionCount);

  for (const [tierStr, cap] of Object.entries(DUNBAR_CAPS)) {
    const tier = Number(tierStr) as QuantTier;
    if (cap === undefined) continue;
    const inTier = [...scores.entries()].filter(([, s]) => s.tier === tier);
    if (inTier.length <= cap) continue;

    inTier.sort(
      (a, b) => a[1].score - b[1].score || (countOf.get(a[0]) ?? 0) - (countOf.get(b[0]) ?? 0),
    );
    for (const [uid, s] of inTier.slice(0, inTier.length - cap)) {
      const next = Math.min(tier + 1, 4) as QuantTier;
      scores.set(uid, { score: s.score, tier: next });
      demoted.push({ uid, from: tier, to: next });
    }
  }
  return demoted;
}

/** 汇集一个 chat 全部活跃成员的评分输入 (activity ∪ profiles ∪ relationships)。 */
function gatherChatMemberStats(chatId: number): MemberStat[] {
  const db = getDb();
  const windowStart = dateDaysAgo(AFFINITY_WINDOW_DAYS);
  const byUid = new Map<number, MemberStat>();
  const getOrCreate = (uid: number): MemberStat => {
    let s = byUid.get(uid);
    if (!s) {
      s = {
        uid,
        interactionCount: 0,
        activeDays: 0,
        depth: 0,
        lastInteractionAt: null,
        existingScore: 0,
        qualityDelta: 0,
      };
      byUid.set(uid, s);
    }
    return s;
  };
  const bumpLastInteraction = (s: MemberStat, ts: number | null | undefined): void => {
    if (ts && ts > 0 && (s.lastInteractionAt === null || ts > s.lastInteractionAt)) {
      s.lastInteractionAt = ts;
    }
  };

  const activityRows = db
    .prepare(
      `SELECT uid, SUM(msg_count) AS c, COUNT(DISTINCT date) AS d, MAX(date) AS last_date
         FROM relationship_activity_daily
        WHERE chat_id = ? AND date >= ?
        GROUP BY uid`,
    )
    .all(chatId, windowStart) as Array<{ uid: number; c: number; d: number; last_date: string }>;
  for (const r of activityRows) {
    const s = getOrCreate(r.uid);
    s.interactionCount = r.c;
    s.activeDays = r.d;
    bumpLastInteraction(s, Date.parse(`${r.last_date}T00:00:00Z`) / 1000);
  }

  const profileRows = db
    .prepare('SELECT uid, updated_at FROM user_profiles WHERE chat_id = ?')
    .all(chatId) as Array<{ uid: number; updated_at: number }>;
  for (const r of profileRows) {
    bumpLastInteraction(getOrCreate(r.uid), r.updated_at);
  }

  // 画像深度 = 该用户全部分区的 bullet 总数 (坏 JSON 按 0 计, fail-soft)。
  const sectionRows = db
    .prepare('SELECT uid, bullets FROM user_profile_sections WHERE chat_id = ?')
    .all(chatId) as Array<{ uid: number; bullets: string }>;
  for (const r of sectionRows) {
    try {
      const parsed = JSON.parse(r.bullets) as unknown;
      if (Array.isArray(parsed)) getOrCreate(r.uid).depth += parsed.length;
    } catch {
      /* non-critical */
    }
  }

  const relRows = db
    .prepare(
      `SELECT uid, last_interaction_at, quant_score, quant_quality_pending
         FROM chat_relationships WHERE chat_id = ?`,
    )
    .all(chatId) as Array<{
    uid: number;
    last_interaction_at: number;
    quant_score: number;
    quant_quality_pending: number;
  }>;
  for (const r of relRows) {
    const s = getOrCreate(r.uid);
    bumpLastInteraction(s, r.last_interaction_at);
    s.existingScore = r.quant_score;
    s.qualityDelta = r.quant_quality_pending;
  }

  return [...byUid.values()];
}

/**
 * 计算单个 (chatId, uid) 的量化分数: 拉全 chat 成员做百分位上下文,取该用户结果。
 * 不持久化 (写库走 recomputeChatRelationships)。flag 关或该用户无任何记录 → null。
 */
export function computeQuantAffinity(chatId: number, uid: number): QuantScore | null {
  if (!env().RELATIONSHIP_QUANT_ENABLED) return null;
  try {
    const members = gatherChatMemberStats(chatId);
    if (!members.some((m) => m.uid === uid)) return null;
    const scores = computeQuantScores(members, { isDM: chatId > 0 });
    return scores.get(uid) ?? null;
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'computeQuantAffinity failed (non-critical)');
    return null;
  }
}

/**
 * 按 tier 裁剪 user_profile_sections 画像精度 (CGM trimProfileByTier 移植):
 *   stable_facts ≤ maxTraits, topics ≤ maxInterests (保留前 N 条),
 *   recent 分区超过 episodeDays 天没更新则整条删除 (不熟的人主动遗忘)。
 * 由 RELATIONSHIP_PROFILE_TRIM_ENABLED 门控; fail-soft 返回是否发生裁剪。
 */
export function trimProfileByTier(chatId: number, uid: number, tier: QuantTier): boolean {
  if (!env().RELATIONSHIP_PROFILE_TRIM_ENABLED) return false;
  try {
    const t: QuantTier = tier >= 1 && tier <= 4 ? tier : 4;
    const limits = TIER_LIMITS[t];
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT section_name, bullets, updated_at FROM user_profile_sections
         WHERE chat_id = ? AND uid = ?`,
      )
      .all(chatId, uid) as Array<{ section_name: string; bullets: string; updated_at: number }>;

    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const row of rows) {
      if (row.section_name === TRAITS_SECTION || row.section_name === INTERESTS_SECTION) {
        const cap = row.section_name === TRAITS_SECTION ? limits.maxTraits : limits.maxInterests;
        let bullets: string[];
        try {
          const parsed = JSON.parse(row.bullets) as unknown;
          if (!Array.isArray(parsed)) continue;
          bullets = parsed.filter((b): b is string => typeof b === 'string');
        } catch {
          continue;
        }
        if (bullets.length > cap) {
          db.prepare(
            `UPDATE user_profile_sections SET bullets = ?, updated_at = ?
             WHERE chat_id = ? AND uid = ? AND section_name = ?`,
          ).run(JSON.stringify(bullets.slice(0, cap)), now, chatId, uid, row.section_name);
          changed = true;
        }
      } else if (row.section_name === EPISODES_SECTION) {
        if (now - row.updated_at > limits.episodeDays * 86400) {
          db.prepare(
            `DELETE FROM user_profile_sections
             WHERE chat_id = ? AND uid = ? AND section_name = ?`,
          ).run(chatId, uid, row.section_name);
          changed = true;
        }
      }
    }
    return changed;
  } catch (err) {
    logger.debug({ err, chatId, uid, tier }, 'trimProfileByTier failed (non-critical)');
    return false;
  }
}

export interface RecomputeResult {
  members: number;
  demoted: number;
  trimmed: number;
}

/**
 * 编排: 重算一个 chat 全部活跃成员的量化分数,应用 tier + Dunbar 降级并持久化
 * (quant_* 侧车列,quality 增量消费清零); trim flag 开时按 tier 裁剪画像;
 * 顺手清理窗口外的日活行。flag 关时 no-op。
 */
export function recomputeChatRelationships(chatId: number): RecomputeResult {
  const empty: RecomputeResult = { members: 0, demoted: 0, trimmed: 0 };
  if (!env().RELATIONSHIP_QUANT_ENABLED) return empty;
  try {
    const db = getDb();
    const members = gatherChatMemberStats(chatId);
    if (members.length === 0) return empty;

    const scores = computeQuantScores(members, { isDM: chatId > 0 });
    const demotions = applyDunbarCaps(scores, members);

    const now = Math.floor(Date.now() / 1000);
    const upsert = db.prepare(
      `INSERT INTO chat_relationships
         (chat_id, uid, affinity, interaction_count, last_interaction_at, last_summary,
          updated_at, quant_score, quant_tier, quant_quality_pending, quant_updated_at)
       VALUES (?, ?, 0, 0, ?, '', ?, ?, ?, 0, ?)
       ON CONFLICT(chat_id, uid) DO UPDATE SET
         quant_score = excluded.quant_score,
         quant_tier = excluded.quant_tier,
         quant_quality_pending = 0,
         quant_updated_at = excluded.quant_updated_at`,
    );
    const byUid = new Map(members.map((m) => [m.uid, m]));
    db.transaction(() => {
      for (const [uid, s] of scores) {
        const lastAt = byUid.get(uid)?.lastInteractionAt ?? now;
        upsert.run(chatId, uid, lastAt, now, s.score, s.tier, now);
      }
      // 窗口外的日活行不再有评分价值,清掉控制表体积。
      db.prepare('DELETE FROM relationship_activity_daily WHERE chat_id = ? AND date < ?').run(
        chatId,
        dateDaysAgo(ACTIVITY_RETENTION_DAYS),
      );
    })();

    let trimmed = 0;
    if (env().RELATIONSHIP_PROFILE_TRIM_ENABLED) {
      for (const [uid, s] of scores) {
        if (trimProfileByTier(chatId, uid, s.tier)) trimmed++;
      }
    }

    logger.debug(
      { chatId, members: members.length, demoted: demotions.length, trimmed },
      'relationship-quant: chat recompute done',
    );
    return { members: members.length, demoted: demotions.length, trimmed };
  } catch (err) {
    logger.warn({ err, chatId }, 'recomputeChatRelationships failed (non-critical)');
    return empty;
  }
}

/** 全量入口: 所有有活动/有关系记录的 chat 逐个重算 (单 chat 失败不影响其他)。 */
export function recomputeAllChats(): { chats: number; members: number; demoted: number; trimmed: number } {
  const total = { chats: 0, members: 0, demoted: 0, trimmed: 0 };
  if (!env().RELATIONSHIP_QUANT_ENABLED) return total;
  try {
    const db = getDb();
    const windowStart = dateDaysAgo(AFFINITY_WINDOW_DAYS);
    const rows = db
      .prepare(
        `SELECT chat_id FROM (
           SELECT chat_id FROM relationship_activity_daily WHERE date >= ?
           UNION
           SELECT chat_id FROM chat_relationships
         )`,
      )
      .all(windowStart) as Array<{ chat_id: number }>;
    for (const row of rows) {
      const r = recomputeChatRelationships(row.chat_id);
      if (r.members > 0) {
        total.chats++;
        total.members += r.members;
        total.demoted += r.demoted;
        total.trimmed += r.trimmed;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'recomputeAllChats failed (non-critical)');
  }
  return total;
}
