// ────────────────────────────────────────
// Cognitive Debt — 未完成认知 store (CSR Phase B)
//
// bot 每次：未验证就下结论 / 对用户承诺 / 遇到矛盾放过 / 被纠正 /
// 暂停任务 / 说"之后再看"，都会积累一条认知债务。
// 新事件到来时检查是否偿还/触发债务；过期债务自动失效。
// 存储遵循项目惯例：better-sqlite3 同步 API、永不 throw 炸主流程。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export type DebtKind =
  | 'promise'
  | 'uncertainty'
  | 'correction'
  | 'unfinished_task'
  | 'conflict'
  | 'stale_belief';

export type DebtStatus = 'open' | 'resolved' | 'superseded' | 'expired';

export interface CognitiveDebt {
  id: number;
  chatId: number;
  ownerUid: number | null;
  taskId: string | null;
  kind: DebtKind;
  statement: string;
  sourceEventIds: string[];
  priority: number;
  confidence: number;
  status: DebtStatus;
  resolution: string | null;
  supersededBy: number | null;
  createdAt: number;
  updatedAt: number;
  nextCheckAt: number | null;
  expiresAt: number | null;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function rowToDebt(r: Record<string, unknown>): CognitiveDebt {
  let sourceEventIds: string[] = [];
  try {
    const parsed = JSON.parse(String(r.source_event_ids ?? '[]'));
    if (Array.isArray(parsed)) sourceEventIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* keep empty */ }
  return {
    id: r.id as number,
    chatId: r.chat_id as number,
    ownerUid: (r.owner_uid as number | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    kind: r.kind as DebtKind,
    statement: r.statement as string,
    sourceEventIds,
    priority: r.priority as number,
    confidence: r.confidence as number,
    status: r.status as DebtStatus,
    resolution: (r.resolution as string | null) ?? null,
    supersededBy: (r.superseded_by as number | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    nextCheckAt: (r.next_check_at as number | null) ?? null,
    expiresAt: (r.expires_at as number | null) ?? null,
  };
}

const DEBT_MAX_STATEMENT = 400;

/** 新增一条认知债务。返回 id，失败返回 null（债务永不炸主流程）。 */
export function createDebt(input: {
  chatId: number;
  ownerUid?: number;
  taskId?: string;
  kind: DebtKind;
  statement: string;
  sourceEventIds?: string[];
  priority?: number;
  confidence?: number;
  ttlSec?: number;
  nextCheckInSec?: number;
}): number | null {
  const statement = input.statement.trim().slice(0, DEBT_MAX_STATEMENT);
  if (!statement) return null;
  const ts = nowSec();
  try {
    const r = getDb()
      .prepare(
        `INSERT INTO cognitive_debts
           (chat_id, owner_uid, task_id, kind, statement, source_event_ids, priority, confidence,
            status, created_at, updated_at, next_check_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        input.chatId,
        input.ownerUid ?? null,
        input.taskId ?? null,
        input.kind,
        statement,
        JSON.stringify((input.sourceEventIds ?? []).slice(0, 12)),
        Math.min(10, Math.max(1, input.priority ?? 5)),
        Math.min(1, Math.max(0, input.confidence ?? 0.5)),
        ts,
        ts,
        input.nextCheckInSec ? ts + input.nextCheckInSec : null,
        input.ttlSec ? ts + input.ttlSec : null,
      );
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err, kind: input.kind }, 'createDebt failed');
    return null;
  }
}

function rowToDebtList(rows: Record<string, unknown>[]): CognitiveDebt[] {
  return rows.map(rowToDebt);
}

/** 某个 chat 的 open 债务，按优先级+更新时间。 */
export function listOpenDebts(chatId: number, limit = 10): CognitiveDebt[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM cognitive_debts
         WHERE chat_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY priority DESC, updated_at DESC LIMIT ?`,
      )
      .all(chatId, nowSec(), limit) as Record<string, unknown>[];
    return rowToDebtList(rows);
  } catch (err) {
    logger.warn({ err, chatId }, 'listOpenDebts failed');
    return [];
  }
}

/** 到期待处理的 open 债务（后台扫描用）。 */
export function listDueDebts(limit = 20): CognitiveDebt[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM cognitive_debts
         WHERE status = 'open' AND next_check_at IS NOT NULL AND next_check_at <= ?
         ORDER BY priority DESC, next_check_at ASC LIMIT ?`,
      )
      .all(nowSec(), limit) as Record<string, unknown>[];
    return rowToDebtList(rows);
  } catch (err) {
    logger.warn({ err }, 'listDueDebts failed');
    return [];
  }
}

/**
 * 关键词重叠匹配：当前消息是否与某条 open 债务相关。
 * 与 memory 检索同哲学——轻量滑窗重叠，不引外部依赖。
 */
export function findRelatedDebts(chatId: number, text: string, limit = 3): CognitiveDebt[] {
  const clean = text.trim();
  if (!clean) return [];
  const grams = new Set<string>();
  const chars = [...clean];
  for (let i = 0; i < chars.length - 1; i++) {
    const g = `${chars[i]}${chars[i + 1]}`;
    if (/[\p{L}\p{N}]/u.test(chars[i]!) && /[\p{L}\p{N}]/u.test(chars[i + 1]!)) grams.add(g);
  }
  if (grams.size === 0) return [];
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM cognitive_debts
         WHERE chat_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY priority DESC, updated_at DESC LIMIT 50`,
      )
      .all(chatId, nowSec()) as Record<string, unknown>[];
    const scored = rowToDebtList(rows)
      .map((debt) => {
        const dChars = [...debt.statement];
        let overlap = 0;
        for (let i = 0; i < dChars.length - 1; i++) {
          const g = `${dChars[i]}${dChars[i + 1]}`;
          if (grams.has(g)) overlap++;
        }
        return { debt, overlap };
      })
      .filter((x) => x.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap || b.debt.priority - a.debt.priority);
    return scored.slice(0, limit).map((x) => x.debt);
  } catch (err) {
    logger.warn({ err, chatId }, 'findRelatedDebts failed');
    return [];
  }
}

/** 债务已解决（含客观证据摘要）。 */
export function resolveDebt(id: number, resolution: string): boolean {
  try {
    const r = getDb()
      .prepare(
        `UPDATE cognitive_debts SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
      )
      .run(resolution.trim().slice(0, 400), nowSec(), id);
    return r.changes === 1;
  } catch (err) {
    logger.warn({ err, id }, 'resolveDebt failed');
    return false;
  }
}

/** 旧判断被新事实取代。 */
export function supersedeDebt(id: number, byDebtId: number | null, resolution: string): boolean {
  try {
    const r = getDb()
      .prepare(
        `UPDATE cognitive_debts SET status = 'superseded', superseded_by = ?, resolution = ?, updated_at = ? WHERE id = ? AND status = 'open'`,
      )
      .run(byDebtId, resolution.trim().slice(0, 400), nowSec(), id);
    return r.changes === 1;
  } catch (err) {
    logger.warn({ err, id }, 'supersedeDebt failed');
    return false;
  }
}

/** 推迟下一次检查（扫描后仍无法偿还时）。 */
export function snoozeDebt(id: number, nextCheckInSec: number): boolean {
  try {
    const r = getDb()
      .prepare(`UPDATE cognitive_debts SET next_check_at = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
      .run(nowSec() + Math.max(60, nextCheckInSec), nowSec(), id);
    return r.changes === 1;
  } catch (err) {
    logger.warn({ err, id }, 'snoozeDebt failed');
    return false;
  }
}

/** 某 task 名下的 open 债务（等待/未竟任务恢复或终结时偿还）。 */
export function listOpenDebtsByTask(taskId: string): CognitiveDebt[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM cognitive_debts
         WHERE task_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY priority DESC, updated_at DESC`,
      )
      .all(taskId, nowSec()) as Record<string, unknown>[];
    return rowToDebtList(rows);
  } catch (err) {
    logger.warn({ err, taskId }, 'listOpenDebtsByTask failed');
    return [];
  }
}

/** 按 task 批量偿还 open 债务。返回偿还条数。 */
export function resolveOpenDebtsByTask(taskId: string, resolution: string): number {
  try {
    const r = getDb()
      .prepare(
        `UPDATE cognitive_debts SET status = 'resolved', resolution = ?, updated_at = ?
         WHERE task_id = ? AND status = 'open'`,
      )
      .run(resolution.trim().slice(0, 400), nowSec(), taskId);
    return r.changes;
  } catch (err) {
    logger.warn({ err, taskId }, 'resolveOpenDebtsByTask failed');
    return 0;
  }
}

/** 后台清理：过期 open 债务置 expired。返回清理条数。 */
export function expireStaleDebts(): number {
  try {
    const r = getDb()
      .prepare(
        `UPDATE cognitive_debts SET status = 'expired', updated_at = ?
         WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(nowSec(), nowSec());
    return r.changes;
  } catch (err) {
    logger.warn({ err }, 'expireStaleDebts failed');
    return 0;
  }
}
