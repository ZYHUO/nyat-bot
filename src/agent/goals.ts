// ────────────────────────────────────────
// Curiosity Goal Tracker — 持续关注的目标 (AGI Level 4 P4-B)
//
// self-play 是「无聊了随便玩」，玩完就忘。goals 表把「这个值得持续关注」
// 固化下来：LLM 自主立（distiller follow_up_goal / self-play）、主人指派、
// 周期性 CodeAct 去查进展，有新发现主动汇报，7 天无进展自然 stale。
// 这是 agent 和「高级客服」的分水岭：有自己的事。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export type GoalStatus = 'active' | 'achieved' | 'stale' | 'dropped';

export interface GoalRow {
  id: number;
  topic: string;
  origin: string;
  chat_id: number | null;
  status: GoalStatus;
  check_interval_sec: number;
  last_check_at: number | null;
  last_finding: string | null;
  findings_count: number;
  check_count: number;
  long_term: number;
  created_at: number;
  updated_at: number;
}

export interface GoalSubtaskRow {
  id: number;
  goal_id: number;
  parent_id: number | null;
  description: string;
  status: string;
  result: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateGoalInput {
  topic: string;
  origin: string; // 'self' | 'master' | `episode:${id}`
  chatId?: number | null;
  checkIntervalSec?: number;
  /** AGI Level 5 Phase 3: 长期目标(跨周持续关注,stale 放宽到 30 天)。 */
  longTerm?: boolean;
}

/** 连续多少天无新发现 → stale(cron 里用)。 */
export const GOAL_STALE_AFTER_SEC = 7 * 86400;
/** 长期目标的 stale 窗口(30 天,跨周持续关注不轻易放弃)。 */
export const GOAL_LONG_TERM_STALE_AFTER_SEC = 30 * 86400;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** goal topic 归一化：去前缀套话/标点/空白/大小写，只留内容字符（中英日韩）。 */
function normalizeGoalTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/兑现承诺[:：]?|持续关注|后续|有新消息就推送到群里。?|看看有没有新进展。?/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符 bigram 重叠率（Dice 系数）：|A∩B|*2/(|A|+|B|)。 */
function bigramOverlap(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** 立 goal。返回 rowid；超上限或重复 topic（active 中已有同 topic）返回 null。 */
export function createGoal(input: CreateGoalInput, maxActive = 5): number | null {
  try {
    const db = getDb();
    const topic = input.topic.trim().slice(0, 100);
    // 中文 2-3 字就够(比特币/显卡/比赛),但去掉纯标点/单字。
    if (topic.length < 2) return null;
    if (!/[^\s\p{P}\p{S}]/u.test(topic)) return null;
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM goals WHERE status = 'active'`).get() as { c: number };
    if (c >= maxActive) {
      logger.info({ topic }, 'goal rejected: max active reached');
      return null;
    }
    const dup = db
      .prepare(`SELECT id FROM goals WHERE status = 'active' AND topic = ?`)
      .get(topic) as { id: number } | undefined;
    if (dup) return null;
    // 同主题查重（2026-08-22 自我增殖事故：goal check 完成后 episode 蒸馏又立同主题
    // goal，措辞略异绕过精确匹配——「DeepSeek 定价」繁殖出两条、「AI 模型定价」两条）。
    // 归一化后互为子串或字符 bigram 重叠 ≥0.55 即同一主题——数据质量查重，非语义引擎。
    const normTopic = normalizeGoalTopic(topic);
    if (normTopic.length >= 6) {
      const actives = db
        .prepare(`SELECT id, topic FROM goals WHERE status = 'active'`)
        .all() as { id: number; topic: string }[];
      for (const g of actives) {
        const normExisting = normalizeGoalTopic(g.topic);
        if (normExisting.length < 6) continue;
        if (normTopic.includes(normExisting) || normExisting.includes(normTopic)) {
          logger.info({ topic, existingId: g.id }, 'goal rejected: substring dup');
          return null;
        }
        if (bigramOverlap(normTopic, normExisting) >= 0.55) {
          logger.info({ topic, existingId: g.id }, 'goal rejected: topic overlap dup');
          return null;
        }
      }
    }
    // 同一任务只立一个 goal：promise-backstop 和 episode 蒸馏会从同一个 taskId
    // 各立一次（措辞不同绕过 topic 去重）——2026-08-22 实测 goal 8/9 重复
    // （「团毛球」vs「清理猫毛」同一承诺）。origin 形如 promise-backstop:<taskId> /
    // episode:<taskId> / promise:<taskId>，按 taskId 段查重。
    const originTask = input.origin.split(':')[1]?.trim();
    if (originTask && originTask.length >= 6) {
      const dupTask = db
        .prepare(`SELECT id FROM goals WHERE status = 'active' AND origin LIKE ?`)
        .get(`%:${originTask}`) as { id: number } | undefined;
      if (dupTask) {
        logger.info({ topic, origin: input.origin, existingId: dupTask.id }, 'goal rejected: same task already has active goal');
        return null;
      }
    }
    const ts = nowSec();
    const r = db
      .prepare(
        `INSERT INTO goals (topic, origin, chat_id, check_interval_sec, long_term, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        topic,
        input.origin.slice(0, 64),
        input.chatId ?? null,
        input.checkIntervalSec ?? 86400,
        input.longTerm ? 1 : 0,
        ts,
        ts,
      );
    logger.info({ topic, origin: input.origin }, 'goal created');
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err }, 'createGoal failed');
    return null;
  }
}

/** 到期的 active goals：从未查过，或距上次检查 ≥ check_interval_sec。 */
export function listDueGoals(now = nowSec()): GoalRow[] {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM goals
         WHERE status = 'active'
           AND (last_check_at IS NULL OR last_check_at + check_interval_sec <= ?)
         ORDER BY COALESCE(last_check_at, 0) ASC
         LIMIT 4`,
      )
      .all(now) as GoalRow[];
  } catch (err) {
    logger.warn({ err }, 'listDueGoals failed');
    return [];
  }
}

/**
 * 记录一次检查结果。finding 非空 = 有新发现（findings_count++）；
 * 创建超过 GOAL_STALE_AFTER_SEC 仍零发现的 goal → 自动 stale。
 */
export function recordCheck(id: number, finding: string | null): void {
  try {
    const ts = nowSec();
    const db = getDb();
    if (finding?.trim()) {
      db.prepare(
        `UPDATE goals SET last_check_at = ?, last_finding = ?, findings_count = findings_count + 1,
           check_count = check_count + 1, updated_at = ? WHERE id = ?`,
      ).run(ts, finding.trim().slice(0, 500), ts, id);
    } else {
      db.prepare(`UPDATE goals SET last_check_at = ?, check_count = check_count + 1, updated_at = ? WHERE id = ?`).run(ts, ts, id);
      // 零发现且活够久了 → stale(保留可复活,不再轮询)。
      // 长期目标(long_term=1)的 stale 窗口放宽到 30 天(跨周持续关注不轻易放弃)。
      db.prepare(
        `UPDATE goals SET status = 'stale', updated_at = ?
         WHERE id = ? AND status = 'active' AND findings_count = 0
           AND created_at + CASE long_term WHEN 1 THEN ? ELSE ? END <= ?`,
      ).run(ts, id, GOAL_LONG_TERM_STALE_AFTER_SEC, GOAL_STALE_AFTER_SEC, ts);
    }
  } catch (err) {
    logger.warn({ err, id }, 'recordCheck failed');
  }
}

/** 标记一次 silent change(世界悄悄变了,LLM 对比上次 finding 发现变化)。 */
export function markSilentChange(id: number): void {
  try {
    getDb()
      .prepare(`UPDATE goals SET silent_change_detected = 1, updated_at = ? WHERE id = ?`)
      .run(nowSec(), id);
  } catch (err) {
    logger.warn({ err, id }, 'markSilentChange failed');
  }
}

export function setGoalStatus(id: number, status: GoalStatus): void {
  try {
    getDb().prepare(`UPDATE goals SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowSec(), id);
  } catch (err) {
    logger.warn({ err, id, status }, 'setGoalStatus failed');
  }
}

export function listGoals(status?: GoalStatus): GoalRow[] {
  try {
    const db = getDb();
    if (status) {
      return db.prepare(`SELECT * FROM goals WHERE status = ? ORDER BY updated_at DESC`).all(status) as GoalRow[];
    }
    return db.prepare(`SELECT * FROM goals ORDER BY updated_at DESC LIMIT 50`).all() as GoalRow[];
  } catch (err) {
    logger.warn({ err }, 'listGoals failed');
    return [];
  }
}

// ────────────────────────────────────────
// Goal Subtasks — AGI Level 6 P4 subtree
// ────────────────────────────────────────

/** 给一个 goal 创建子树根节点。 */
export function createSubtask(input: {
  goalId: number;
  description: string;
  parentId?: number | null;
}): number | null {
  try {
    const ts = nowSec();
    const r = getDb()
      .prepare(
        `INSERT INTO goal_subtasks (goal_id, parent_id, description, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(input.goalId, input.parentId ?? null, input.description.slice(0, 200), ts, ts);
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err }, 'createSubtask failed');
    return null;
  }
}

/** 某个 goal 的全部 subtask。 */
export function listSubtasks(goalId: number): GoalSubtaskRow[] {
  try {
    return getDb()
      .prepare(`SELECT * FROM goal_subtasks WHERE goal_id = ? ORDER BY id ASC`)
      .all(goalId) as GoalSubtaskRow[];
  } catch {
    return [];
  }
}

/** pending → running | done | blocked。 */
export function setSubtaskStatus(id: number, status: string, result?: string): void {
  try {
    const ts = nowSec();
    if (result !== undefined) {
      getDb()
        .prepare(`UPDATE goal_subtasks SET status = ?, result = ?, updated_at = ? WHERE id = ?`)
        .run(status, result.slice(0, 500), ts, id);
    } else {
      getDb().prepare(`UPDATE goal_subtasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, ts, id);
    }
  } catch (err) {
    logger.warn({ err }, 'setSubtaskStatus failed');
  }
}

/** 某个 goal 下一个 pending subtask（给 worker 调度）。 */
export function nextPendingSubtask(goalId: number): GoalSubtaskRow | null {
  try {
    const row = getDb()
      .prepare(`SELECT * FROM goal_subtasks WHERE goal_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1`)
      .get(goalId) as GoalSubtaskRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** 某个 goal 是否全部完成。 */
export function isGoalComplete(goalId: number): boolean {
  try {
    const r = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM goal_subtasks WHERE goal_id = ? AND status != 'done'`)
      .get(goalId) as { c: number };
    return r.c === 0;
  } catch {
    return false;
  }
}
