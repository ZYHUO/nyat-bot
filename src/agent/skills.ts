// ────────────────────────────────────────
// Skills Store — 自我技能沉淀 (AGI 自我 skill 系统)
//
// 区别于 experience_entries(碎片化经验,单条 ≤500 字):
// skill 是结构化能力单元 —— 有名字、触发条件、步骤、坑。
// 每 6h 从 episodes + experience_entries 蒸馏「小 skill」,
// 每周合并去重成「大 skill」,小 skill 归档防爆。
// 注入 executor 时按 contentDirection 检索相关 skill,让 bot
// 复用自己沉淀下来的「怎么做」,而不只是「别踩什么坑」。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export type SkillTier = 'small' | 'big';

export interface SkillInput {
  name: string;
  tier: SkillTier;
  triggerWhen: string;
  steps: string;
  pitfalls?: string;
  summary?: string;
  tags: string[];
  sourceSkillIds?: number[];
}

export interface SkillHit {
  id: number;
  name: string;
  tier: SkillTier;
  triggerWhen: string;
  steps: string;
  pitfalls: string | null;
  summary: string | null;
  tags: string[];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function safeJsonArray(v: unknown): string {
  try {
    return JSON.stringify(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : []);
  } catch {
    return '[]';
  }
}

/** 保存一个 skill。返回 rowid,失败返回 null(沉淀不该炸主流程)。 */
export function saveSkill(s: SkillInput): number | null {
  try {
    const r = getDb()
      .prepare(
        `INSERT INTO skills (name, tier, trigger_when, steps, pitfalls, summary, tags, source_skill_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.name.trim().slice(0, 80),
        s.tier,
        s.triggerWhen.trim().slice(0, 500),
        s.steps.trim().slice(0, 2000),
        s.pitfalls?.trim().slice(0, 1000) ?? null,
        s.summary?.trim().slice(0, 300) ?? null,
        safeJsonArray(s.tags),
        s.sourceSkillIds?.length ? JSON.stringify(s.sourceSkillIds.slice(0, 50)) : null,
        nowSec(),
      );
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err, name: s.name }, 'saveSkill failed');
    return null;
  }
}

/** Verified-use signal: incremented only when a task using this skill reaches host-verified assessment.
 * Retrieval counts (use_count) measure recall, not helpfulness — never conflate the two. */
export function recordSkillVerifiedUse(ids: number[], evidence: 'verified' | 'failed' | 'unverified'): void {
  if (evidence !== 'verified' || !ids.length) return;
  try {
    const stmt = getDb().prepare(
      `UPDATE skills SET verified_use_count = verified_use_count + 1, last_verified_use_at = ? WHERE id = ?`,
    );
    const ts = Math.floor(Date.now() / 1000);
    for (const id of ids) stmt.run(ts, id);
  } catch (err) {
    logger.warn({ err }, 'recordSkillVerifiedUse failed');
  }
}

/** 归档一批小 skill(被大 skill 回收后,不再注入但保留历史)。 */
export function archiveSkills(ids: number[]): void {
  if (!ids.length) return;
  try {
    const stmt = getDb().prepare(`UPDATE skills SET archived = 1 WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  } catch (err) {
    logger.warn({ err, ids }, 'archiveSkills failed');
  }
}

/** 取最近 N 个未归档的小 skill(供每周合并用)。 */
export function getRecentSmallSkills(limit = 100): SkillHit[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, name, tier, trigger_when, steps, pitfalls, summary, tags
         FROM skills WHERE tier = 'small' AND archived = 0
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as (SkillHit & { tags: string })[];
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
  } catch (err) {
    logger.warn({ err }, 'getRecentSmallSkills failed');
    return [];
  }
}

function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 按查询文本检索相关 skill(FTS)。命中即 use_count++ / last_used_at 更新。
 * 只返回未归档的 skill(归档 = 已被大 skill 回收,不再注入)。
 */
/**
 * 把查询切成匹配单元：CJK 取二元组，拉丁/数字取整词。
 *
 * 为什么是二元组：见下面 findRelevantSkills 的长注释。
 */
function bigramsOf(query: string): string[] {
  const cleaned = query.replace(/["'*():^%]/g, ' ');
  const out: string[] = [];
  for (const w of cleaned.split(/[\s，。、,.!?;；/\\-]+/)) {
    const t = w.trim();
    if (/^[\w.-]{2,}$/.test(t)) out.push(t);
  }
  for (const run of cleaned.match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }
  return [...new Set(out)].slice(0, 24);
}

export function findRelevantSkills(query: string, limit = 2): SkillHit[] {
  try {
    const db = getDb();
    const units = bigramsOf(query);
    if (!units.length) return [];

    // **不用 FTS，用 LIKE。** 2026-09-21：`skill recall injected` 生产 0 次，
    // 探针 6 条真实 task 方向全返回 0。病因不是切词，是 **skills_fts 的Tokenizer**。
    //
    // skills_fts 是 fts5 外部内容表（migrations/0071），用默认 unicode61。
    // 实测它把**整段中文连续串当成一个 token**：
    //   "人设群聊接梗"（skill 17 的 name 原样）      → 1 命中
    //   "承诺跟踪"（skill 20 的 name 原样）          → 2 命中
    //   "人设" → 7,8        "群聊" → 5,7,11,12      （这两个在别的字段里是完整串）
    //   "承诺" / "交付" / "口吻" / "语气" / "跟踪"    → **全 0**
    //   "人" / "设" / "承" / "诺"（单字）            → **全 0**
    //
    // 也就是说短语查询只有**恰好等于某个字段里的完整中文串**才命中。
    // 而 task 的 contentDirection 是模型写的自由文本，永远不可能和
    // trigger_when/summary 逐字相同——所以这个检索从上线起一次都没成功过。
    //
    // 按二元组 + LIKE：`name LIKE '%人设%'` 这种子串匹配不依赖分词，
    // 20 行表全表扫也只要几十微秒。命中多少个二元组就作为相关度，
    // 比 FTS 的 rank 更直白（这里也没有 BM25 可借）。
    const hay = `(name || ' ' || COALESCE(trigger_when,'') || ' ' || COALESCE(summary,'') || ' ' || COALESCE(steps,'') || ' ' || COALESCE(tags,''))`;
    const params: Array<string | number> = [];
    const scoreExpr = units
      .map((u) => {
        params.push(`%${u}%`);
        return `(CASE WHEN ${hay} LIKE ? THEN 1 ELSE 0 END)`;
      })
      .join(' + ');
    params.push(limit * 3);
    // scoreExpr 在 SELECT 和 WHERE 里各出现一次——所以必须套一层子查询，
    // 让它在文本里只出现一次，否则 `?` 的数量是参数的两倍，绑定会错位。
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT id, name, tier, trigger_when, steps, pitfalls, summary, tags,
                  (${scoreExpr}) AS score
           FROM skills
           WHERE archived = 0
         )
         WHERE score > 0
         ORDER BY score DESC, id ASC
         LIMIT ?`,
      )
      .all(...params) as (SkillHit & { tags: string; score: number })[];
    if (!rows.length) return [];
    // 大 skill 优先(更成熟),同 tier 按相关度序。
    const sorted = [...rows].sort((a, b) =>
      a.tier === b.tier ? b.score - a.score : a.tier === 'big' ? -1 : 1,
    );
    const picked = sorted.slice(0, limit);
    const bump = db.prepare(`UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`);
    const ts = nowSec();
    for (const r of picked) bump.run(ts, r.id);
    return picked.map((r) => ({ ...r, tags: parseTags(r.tags) }));
  } catch (err) {
    logger.debug({ err }, 'findRelevantSkills failed (non-fatal)');
    return [];
  }
}

/**
 * 大 skill 库上限淘汰:超出 maxBig 时按 use_count 升序(少用的先删),
 * 同分按创建时间。小 skill 不在此淘汰(它们每周被归档,由 consolidate 管)。
 */
export function pruneBigSkills(maxBig = 50): void {
  try {
    const db = getDb();
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM skills WHERE tier = 'big' AND archived = 0`).get() as { c: number };
    if (c <= maxBig) return;
    const excess = c - maxBig;
    db.prepare(
      `DELETE FROM skills WHERE id IN (
         SELECT id FROM skills WHERE tier = 'big' AND archived = 0
         ORDER BY use_count ASC, created_at ASC LIMIT ?
       )`,
    ).run(excess);
  } catch (err) {
    logger.warn({ err }, 'pruneBigSkills failed');
  }
}
