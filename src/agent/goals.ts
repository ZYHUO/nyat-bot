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
  created_at: number;
  updated_at: number;
}

export interface CreateGoalInput {
  topic: string;
  origin: string; // 'self' | 'master' | `episode:${id}`
  chatId?: number | null;
  checkIntervalSec?: number;
}

/** 连续多少天无新发现 → stale（cron 里用）。 */
export const GOAL_STALE_AFTER_SEC = 7 * 86400;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
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
    const ts = nowSec();
    const r = db
      .prepare(
        `INSERT INTO goals (topic, origin, chat_id, check_interval_sec, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(topic, input.origin.slice(0, 64), input.chatId ?? null, input.checkIntervalSec ?? 86400, ts, ts);
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
        `UPDATE goals SET last_check_at = ?, last_finding = ?, findings_count = findings_count + 1, updated_at = ? WHERE id = ?`,
      ).run(ts, finding.trim().slice(0, 500), ts, id);
    } else {
      db.prepare(`UPDATE goals SET last_check_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
      // 零发现且活够久了 → stale（保留可复活，不再轮询）。
      db.prepare(
        `UPDATE goals SET status = 'stale', updated_at = ?
         WHERE id = ? AND status = 'active' AND findings_count = 0 AND created_at + ? <= ?`,
      ).run(ts, id, GOAL_STALE_AFTER_SEC, ts);
    }
  } catch (err) {
    logger.warn({ err, id }, 'recordCheck failed');
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
