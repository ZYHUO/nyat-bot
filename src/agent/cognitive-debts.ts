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
import { scopeKey } from '../shared/cognitive-scope.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

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
  resolutionEventId?: string | null;
  supersededBy: number | null;
  createdAt: number;
  updatedAt: number;
  nextCheckAt: number | null;
  expiresAt: number | null;
  scopeKey?: string | null;
  visibility?: 'global' | 'chat' | 'user' | 'task' | null;
  dedupeKey?: string | null;
  /** True when the only available snapshot predates debt history capture. */
  historyLegacy?: boolean;
}

export type DebtMatchKind = 'scope' | 'text' | 'scope_and_text' | 'source_event' | 'semantic';

/** A deterministic match explanation. Semantic/LLM matching must build on this. */
export interface CognitiveDebtMatch {
  debt: CognitiveDebt;
  score: number;
  overlap: number;
  kind: DebtMatchKind;
  reasons: string[];
}

export interface DebtMatchOptions {
  limit?: number;
  maxCandidates?: number;
  minOverlap?: number;
  asOf?: number;
  anchors?: {
    taskId?: string;
    ownerUid?: number;
    sourceEventId?: string;
  };
}

export interface SemanticDebtMatchOptions extends DebtMatchOptions {
  /** Host-owned scorer; the debt module never calls an LLM by itself. */
  semanticScore: (input: { query: string; debt: CognitiveDebt }) => number | Promise<number>;
  /** Maximum scorer calls after deterministic matches have been collected. */
  maxSemanticCandidates?: number;
  /** Scores below this threshold are discarded. */
  minSemanticScore?: number;
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
    resolutionEventId: (r.resolution_event_id as string | null) ?? null,
    supersededBy: (r.superseded_by as number | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    nextCheckAt: (r.next_check_at as number | null) ?? null,
    expiresAt: (r.expires_at as number | null) ?? null,
    scopeKey: (r.scope_key as string | null) ?? null,
    visibility: (r.visibility as CognitiveDebt['visibility']) ?? null,
    dedupeKey: (r.dedupe_key as string | null) ?? null,
    ...(r.legacy !== undefined ? { historyLegacy: Number(r.legacy) === 1 } : {}),
  };
}

const DEBT_MAX_STATEMENT = 400;

function hasColumn(db: ReturnType<typeof getDb>, column: string): boolean {
  try {
    return (db.prepare('PRAGMA table_info(cognitive_debts)').all() as Array<{ name?: string }>).some((item) => item.name === column);
  } catch {
    return false;
  }
}

function hasTable(db: ReturnType<typeof getDb>, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

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
  dedupeKey?: string;
}): number | null {
  const statement = input.statement.trim().slice(0, DEBT_MAX_STATEMENT);
  if (!statement) return null;
  const taskId = input.taskId?.trim().slice(0, 120) || null;
  const dedupeKey = input.dedupeKey?.trim().slice(0, 240) || null;
  const ts = nowSec();
  try {
    const db = getDb();
    const values = [
      input.chatId,
      input.ownerUid ?? null,
      taskId,
      input.kind,
      statement,
      JSON.stringify((input.sourceEventIds ?? []).filter((id) => typeof id === 'string').slice(0, 12)),
      Math.min(10, Math.max(1, input.priority ?? 5)),
      Math.min(1, Math.max(0, input.confidence ?? 0.5)),
      ts,
      ts,
      input.nextCheckInSec ? ts + input.nextCheckInSec : null,
      input.ttlSec ? ts + input.ttlSec : null,
    ];
    if (hasColumn(db, 'scope_key')) {
      const scope = taskId ? `task:${taskId}@chat:${input.chatId}` : `chat:${input.chatId}`;
      const r = db.prepare(
        `INSERT OR IGNORE INTO cognitive_debts
           (chat_id, owner_uid, task_id, kind, statement, source_event_ids, priority, confidence,
            status, created_at, updated_at, next_check_at, expires_at, scope_key, visibility, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...values, scope, taskId ? 'task' : 'chat', dedupeKey);
      if (r.changes === 0 && dedupeKey) {
        const existing = db.prepare('SELECT id FROM cognitive_debts WHERE dedupe_key = ?').get(dedupeKey) as { id?: number } | undefined;
        return existing?.id ? Number(existing.id) : null;
      }
      return r.changes === 1 ? Number(r.lastInsertRowid) : null;
    }
    const r = db.prepare(
      `INSERT INTO cognitive_debts
         (chat_id, owner_uid, task_id, kind, statement, source_event_ids, priority, confidence,
          status, created_at, updated_at, next_check_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    ).run(...values);
    return Number(r.lastInsertRowid);
  } catch (err) {
    logger.warn({ err, kind: input.kind }, 'createDebt failed');
    return null;
  }
}

function rowToDebtList(rows: Record<string, unknown>[]): CognitiveDebt[] {
  return rows.map(rowToDebt);
}

function revisionToDebt(row: Record<string, unknown>): CognitiveDebt {
  return rowToDebt({ ...row, id: row.debt_id });
}

function listHistoricalOpenDebtsScoped(
  db: ReturnType<typeof getDb>,
  scope: CognitiveScope,
  limit: number,
  asOf: number,
): CognitiveDebt[] {
  const keys = scopedDebtKeys(scope);
  const placeholders = keys.map(() => '?').join(',');
  const params: unknown[] = [asOf, ...keys, asOf, asOf];
  let ownerClause = '';
  if (scope.visibility === 'user' && scope.userId !== undefined && Number.isSafeInteger(scope.userId)) {
    ownerClause = ' AND (r.owner_uid IS NULL OR r.owner_uid = ?)';
    params.push(scope.userId);
  }
  params.push(limit);
  const rows = db.prepare(
    `SELECT r.*
       FROM cognitive_debt_revisions r
       JOIN (
         SELECT debt_id, MAX(revision) AS revision
           FROM cognitive_debt_revisions
          WHERE snapshot_at <= ?
          GROUP BY debt_id
       ) latest ON latest.debt_id = r.debt_id AND latest.revision = r.revision
      WHERE r.scope_key IN (${placeholders})
        AND r.status = 'open'
        AND r.created_at <= ?
        AND (r.expires_at IS NULL OR r.expires_at > ?)${ownerClause}
      ORDER BY r.priority DESC, r.updated_at DESC, r.debt_id DESC
      LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(revisionToDebt);
}

function scopedDebtKeys(scope: CognitiveScope): string[] {
  if (scope.visibility === 'task') return [scopeKey(scope), `chat:${scope.chatId}`];
  if (scope.visibility === 'user') return [`chat:${scope.chatId}`, scopeKey(scope)];
  return [`chat:${scope.chatId}`];
}

function validDebtScope(scope: CognitiveScope): boolean {
  if (!scope || scope.visibility === 'global' || !scope.chatId || !Number.isSafeInteger(scope.chatId)) return false;
  if (scope.visibility === 'user') return scope.userId !== undefined && Number.isSafeInteger(scope.userId) && scope.userId !== 0;
  if (scope.visibility === 'task') return Boolean(scope.taskId?.trim());
  return true;
}

/** Read a bounded candidate set without letting a private task leak to chat scope. */
function openDebtCandidates(scope: CognitiveScope, limit: number, asOf?: number): CognitiveDebt[] {
  if (!validDebtScope(scope)) return [];
  try {
    const db = getDb();
    if (asOf !== undefined && hasTable(db, 'cognitive_debt_revisions')) {
      return listHistoricalOpenDebtsScoped(db, scope, limit, asOf);
    }
    if (hasColumn(db, 'scope_key')) {
      const keys = scopedDebtKeys(scope);
      const placeholders = keys.map(() => '?').join(',');
      const params: unknown[] = [...keys, nowSec()];
      let ownerClause = '';
      if (scope.visibility === 'user' && scope.userId !== undefined && Number.isSafeInteger(scope.userId)) {
        ownerClause = ' AND (owner_uid IS NULL OR owner_uid = ?)';
        params.push(scope.userId);
      }
      params.push(limit);
      const rows = db.prepare(
        `SELECT * FROM cognitive_debts
         WHERE scope_key IN (${placeholders}) AND status = 'open'
           AND (expires_at IS NULL OR expires_at > ?)${ownerClause}
         ORDER BY priority DESC, updated_at DESC, id DESC LIMIT ?`,
      ).all(...params) as Record<string, unknown>[];
      return rowToDebtList(rows);
    }
    const legacy = listOpenDebts(scope.chatId!, Math.min(200, limit * 4));
    return legacy.filter((debt) => {
      if (scope.visibility === 'task') return debt.taskId === null || debt.taskId === scope.taskId;
      if (scope.visibility === 'user') return debt.ownerUid === null || debt.ownerUid === scope.userId;
      return debt.taskId === null;
    }).slice(0, limit);
  } catch (err) {
    logger.warn({ err, chatId: scope.chatId }, 'open debt candidates failed');
    return [];
  }
}

function normalizedGrams(value: string): Set<string> {
  const chars = [...value.toLocaleLowerCase().replace(/[ -]/g, ' ').replace(/\s+/g, ' ').trim()];
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    if (/[\p{L}\p{N}]/u.test(chars[i]!) && /[\p{L}\p{N}]/u.test(chars[i + 1]!)) {
      grams.add(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return grams;
}

function sourceIdsForDebt(debt: CognitiveDebt): Set<string> {
  return new Set(debt.sourceEventIds.map((id) => id.trim()).filter(Boolean));
}

/**
 * Deterministically match open debts in an exact request scope.
 *
 * Scope/source anchors outrank text overlap. The matcher never changes debt
 * state; callers still need host-observable evidence to resolve a debt.
 */
export function findRelatedDebtsScoped(
  scope: CognitiveScope,
  text: string,
  options: DebtMatchOptions = {},
): CognitiveDebtMatch[] {
  if (!validDebtScope(scope)) return [];
  const query = text.replace(/[ -]/g, ' ').trim().slice(0, 800);
  const anchors = options.anchors ?? {};
  const anchorTask = anchors.taskId?.trim().slice(0, 120) || undefined;
  const anchorSource = anchors.sourceEventId?.trim().slice(0, 240) || undefined;
  const maxCandidates = Math.min(Math.max(Math.trunc(options.maxCandidates ?? 100), 1), 200);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 3), 1), 50);
  const minOverlap = Math.min(Math.max(Math.trunc(options.minOverlap ?? 2), 1), 20);
  const asOf = Number.isSafeInteger(options.asOf) && (options.asOf as number) > 0 ? options.asOf : undefined;
  const queryGrams = normalizedGrams(query);
  const queryNormalized = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  if (!query && !anchorTask && !anchorSource && anchors.ownerUid === undefined && scope.visibility !== 'task') return [];

  const candidates = openDebtCandidates(scope, maxCandidates, asOf);
  const matches: CognitiveDebtMatch[] = [];
  for (const debt of candidates) {
    const reasons: string[] = [];
    let score = 0;
    let overlap = 0;
    const sourceIds = sourceIdsForDebt(debt);
    if (anchorSource && sourceIds.has(anchorSource)) {
      score += 1000;
      reasons.push('same_source_event');
    }
    if (scope.visibility === 'task' && scope.taskId && debt.taskId === scope.taskId) {
      score += 300;
      reasons.push('same_task_scope');
    }
    if (anchorTask && debt.taskId === anchorTask) {
      score += 300;
      reasons.push('same_task_anchor');
    }
    if (scope.userId !== undefined && debt.ownerUid === scope.userId) {
      score += 100;
      reasons.push('same_user');
    }
    if (anchors.ownerUid !== undefined && debt.ownerUid === anchors.ownerUid) {
      score += 100;
      reasons.push('same_user_anchor');
    }

    if (queryGrams.size > 0) {
      const debtGrams = normalizedGrams(debt.statement);
      for (const gram of queryGrams) if (debtGrams.has(gram)) overlap++;
      if (overlap >= minOverlap) {
        const denominator = Math.max(queryGrams.size, debtGrams.size, 1);
        score += 50 + Math.round((overlap / denominator) * 150);
        reasons.push(`text_overlap:${overlap}`);
      } else if (queryNormalized && debt.statement.toLocaleLowerCase().includes(queryNormalized)) {
        overlap = Math.max(overlap, minOverlap);
        score += 180;
        reasons.push('text_phrase');
      }
    }
    if (score <= 0) continue;
    const hasScope = reasons.some((reason) => reason.startsWith('same_task') || reason.startsWith('same_user'));
    const hasSource = reasons.includes('same_source_event');
    const hasText = reasons.some((reason) => reason.startsWith('text_'));
    const kind: DebtMatchKind = hasSource ? 'source_event' : hasScope && hasText ? 'scope_and_text' : hasScope ? 'scope' : 'text';
    matches.push({ debt, score, overlap, kind, reasons });
  }
  return matches
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || b.debt.priority - a.debt.priority || b.debt.id - a.debt.id)
    .slice(0, limit);
}

/**
 * Add an optional, bounded semantic pass after deterministic matching.
 *
 * The scorer is deliberately injected by the host so it can enforce model,
 * token, timeout and visibility policy. Semantic matches are only ranked for
 * workspace display; this function never resolves or mutates a debt.
 */
export async function findRelatedDebtsScopedWithSemantic(
  scope: CognitiveScope,
  text: string,
  options: SemanticDebtMatchOptions,
): Promise<CognitiveDebtMatch[]> {
  if (!validDebtScope(scope) || typeof options.semanticScore !== 'function') return [];
  const query = text.replace(/[ -]/g, ' ').trim().slice(0, 800);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 3), 1), 50);
  const deterministic = findRelatedDebtsScoped(scope, query, {
    ...options,
    limit: Math.min(50, Math.max(limit, Math.trunc(options.maxCandidates ?? 100))),
  });
  const matchedIds = new Set(deterministic.map((match) => match.debt.id));
  const maxSemanticCandidates = Math.min(
    Math.max(Math.trunc(options.maxSemanticCandidates ?? 8), 0),
    32,
  );
  const minSemanticScore = Math.min(Math.max(
    Number.isFinite(options.minSemanticScore) ? Number(options.minSemanticScore) : 0.65,
    0,
  ), 1);
  if (maxSemanticCandidates === 0 || !query) return deterministic.slice(0, limit);

  const candidates = openDebtCandidates(
    scope,
    Math.min(200, Math.max(maxSemanticCandidates * 2, options.maxCandidates ?? 100)),
    options.asOf,
  );
  const semantic: CognitiveDebtMatch[] = [];
  let calls = 0;
  for (const debt of candidates) {
    if (calls >= maxSemanticCandidates || matchedIds.has(debt.id)) continue;
    calls++;
    let score: number;
    try {
      score = await options.semanticScore({ query, debt });
    } catch (err) {
      logger.debug({ err, debtId: debt.id }, 'semantic debt scorer failed (non-critical)');
      continue;
    }
    if (!Number.isFinite(score) || score < minSemanticScore) continue;
    const bounded = Math.min(1, Math.max(0, score));
    semantic.push({
      debt,
      score: 25 + Math.round(bounded * 100),
      overlap: 0,
      kind: 'semantic',
      reasons: [`semantic_score:${bounded.toFixed(2)}`],
    });
  }
  return [...deterministic, ...semantic]
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || b.debt.priority - a.debt.priority || b.debt.id - a.debt.id)
    .slice(0, limit);
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

/**
 * Scope-aware debt view for cognitive workspaces. A task can see its own task
 * debts plus chat-level debts, while a chat view never sees another task's
 * private debt. The old chat-only API remains for background/legacy callers.
 */
export function listOpenDebtsScoped(scope: CognitiveScope, limit = 10, options: { asOf?: number } = {}): CognitiveDebt[] {
  if (!scope || scope.visibility === 'global' || !scope.chatId || !Number.isSafeInteger(scope.chatId)) return [];
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const asOf = Number.isSafeInteger(options.asOf) && (options.asOf as number) > 0 ? options.asOf : undefined;
  const clock = asOf ?? nowSec();
  try {
    const db = getDb();
    if (asOf !== undefined && hasTable(db, 'cognitive_debt_revisions')) {
      return listHistoricalOpenDebtsScoped(db, scope, take, asOf);
    }
    if (hasColumn(db, 'scope_key')) {
      const keys = scope.visibility === 'task'
        ? [scopeKey(scope), `chat:${scope.chatId}`]
        : scope.visibility === 'user'
          ? [`chat:${scope.chatId}`, scopeKey(scope)]
          : [`chat:${scope.chatId}`];
      const placeholders = keys.map(() => '?').join(',');
      const createdClause = asOf === undefined ? '' : ' AND created_at <= ?';
      const params: unknown[] = asOf === undefined ? [...keys, clock] : [...keys, clock, asOf];
      let ownerClause = '';
      if (scope.visibility === 'user' && scope.userId !== undefined && Number.isSafeInteger(scope.userId)) {
        ownerClause = ' AND (owner_uid IS NULL OR owner_uid = ?)';
        params.push(scope.userId);
      }
      params.push(take);
      const rows = db.prepare(
        `SELECT * FROM cognitive_debts
         WHERE scope_key IN (${placeholders}) AND status = 'open'
           AND (expires_at IS NULL OR expires_at > ?)${createdClause}${ownerClause}
         ORDER BY priority DESC, updated_at DESC LIMIT ?`,
      ).all(...params) as Record<string, unknown>[];
      return rowToDebtList(rows);
    }

    // Before 0093 there is no persisted scope. Filter the legacy chat view in
    // memory so task-private rows still do not cross a workspace boundary.
    const legacy = listOpenDebts(scope.chatId, Math.min(200, take * 4)).filter((debt) => asOf === undefined || debt.createdAt <= asOf);
    const visible = legacy.filter((debt) => {
      if (scope.visibility === 'task') return debt.taskId === null || debt.taskId === scope.taskId;
      if (scope.visibility === 'user') return debt.ownerUid === null || debt.ownerUid === scope.userId;
      return debt.taskId === null;
    });
    return visible.slice(0, take);
  } catch (err) {
    logger.warn({ err, chatId: scope.chatId }, 'listOpenDebtsScoped failed');
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
 * Due debts visible to one scoped background actor. Task-private debts stay
 * with the task runner; the unified tick only receives chat-level obligations.
 */
export function listDueDebtsScoped(scope: CognitiveScope, limit = 20): CognitiveDebt[] {
  if (!scope || scope.visibility === 'global' || !scope.chatId || !Number.isSafeInteger(scope.chatId)) return [];
  const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
  try {
    const db = getDb();
    if (hasColumn(db, 'scope_key')) {
      const keys = scope.visibility === 'task'
        ? [scopeKey(scope), `chat:${scope.chatId}`]
        : scope.visibility === 'user'
          ? [`chat:${scope.chatId}`, scopeKey(scope)]
          : [`chat:${scope.chatId}`];
      const placeholders = keys.map(() => '?').join(',');
      const params: unknown[] = [...keys, nowSec(), nowSec()];
      let ownerClause = '';
      if (scope.visibility === 'user' && scope.userId !== undefined && Number.isSafeInteger(scope.userId)) {
        ownerClause = ' AND (owner_uid IS NULL OR owner_uid = ?)';
        params.push(scope.userId);
      }
      params.push(take);
      const rows = db.prepare(
        `SELECT * FROM cognitive_debts
         WHERE scope_key IN (${placeholders}) AND status = 'open'
           AND next_check_at IS NOT NULL AND next_check_at <= ?
           AND (expires_at IS NULL OR expires_at > ? )${ownerClause}
         ORDER BY priority DESC, next_check_at ASC LIMIT ?`,
      ).all(...params) as Record<string, unknown>[];
      return rowToDebtList(rows);
    }
    const legacy = listDueDebts(Math.min(200, take * 4));
    return legacy
      .filter((debt) => {
        if (debt.chatId !== scope.chatId) return false;
        if (scope.visibility === 'task') return debt.taskId === null || debt.taskId === scope.taskId;
        if (scope.visibility === 'user') return debt.ownerUid === null || debt.ownerUid === scope.userId;
        return debt.taskId === null;
      })
      .slice(0, take);
  } catch (err) {
    logger.warn({ err, chatId: scope.chatId }, 'listDueDebtsScoped failed');
    return [];
  }
}

/**
 * 关键词重叠匹配：当前消息是否与某条 open 债务相关。
 * 与 memory 检索同哲学——轻量滑窗重叠，不引外部依赖。
 */
export function findRelatedDebts(chatId: number, text: string, limit = 3): CognitiveDebt[] {
  return findRelatedDebtsScoped({ visibility: 'chat', chatId }, text, { limit }).map((match) => match.debt);
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

/**
 * Resolve only when the caller supplies the exact scope and an evidence event.
 * This is the sole auto-repay primitive used by the deterministic projector.
 */
export function resolveDebtWithEvidence(input: {
  id: number;
  resolution: string;
  resolutionEventId: string;
  scope?: CognitiveScope;
}): boolean {
  const resolution = input.resolution.trim().slice(0, 400);
  const eventId = input.resolutionEventId.trim().slice(0, 240);
  if (!resolution || !eventId) return false;
  try {
    const db = getDb();
    const row = db.prepare('SELECT chat_id, task_id, scope_key, status FROM cognitive_debts WHERE id = ?').get(input.id) as {
      chat_id?: number; task_id?: string | null; scope_key?: string | null; status?: string;
    } | undefined;
    if (!row || row.status !== 'open') return false;
    if (input.scope) {
      if (!input.scope.chatId || row.chat_id !== input.scope.chatId) return false;
      if (hasColumn(db, 'scope_key')) {
        const expected = input.scope.visibility === 'task'
          ? [scopeKey(input.scope), `chat:${input.scope.chatId}`]
          : input.scope.visibility === 'user'
            ? [`chat:${input.scope.chatId}`, scopeKey(input.scope)]
            : [`chat:${input.scope.chatId}`];
        if (!row.scope_key || !expected.includes(row.scope_key)) return false;
      } else if (input.scope.visibility === 'task' && row.task_id !== null && row.task_id !== input.scope.taskId) {
        return false;
      }
    }
    const ts = nowSec();
    const result = hasColumn(db, 'resolution_event_id')
      ? db.prepare(
          `UPDATE cognitive_debts
           SET status = 'resolved', resolution = ?, resolution_event_id = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        ).run(resolution, eventId, ts, input.id)
      : db.prepare(
          `UPDATE cognitive_debts SET status = 'resolved', resolution = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        ).run(`[event:${eventId}] ${resolution}`.slice(0, DEBT_MAX_STATEMENT), ts, input.id);
    return result.changes === 1;
  } catch (err) {
    logger.warn({ err, id: input.id }, 'resolveDebtWithEvidence failed');
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

/** Resolve a task's open debts only from a matching completed-task event. */
export function resolveOpenDebtsByTaskWithEvidence(input: {
  taskId: string;
  chatId: number;
  resolution: string;
  resolutionEventId: string;
}): number {
  const taskId = input.taskId.trim().slice(0, 120);
  const resolution = input.resolution.trim().slice(0, 400);
  const eventId = input.resolutionEventId.trim().slice(0, 240);
  if (!taskId || !input.chatId || !resolution || !eventId) return 0;
  try {
    const db = getDb();
    const ts = nowSec();
    if (hasColumn(db, 'resolution_event_id')) {
      const result = db.prepare(
        `UPDATE cognitive_debts
         SET status = 'resolved', resolution = ?, resolution_event_id = ?, updated_at = ?
         WHERE task_id = ? AND chat_id = ? AND status = 'open'`,
      ).run(resolution, eventId, ts, taskId, input.chatId);
      return result.changes;
    }
    const result = db.prepare(
      `UPDATE cognitive_debts SET status = 'resolved', resolution = ?, updated_at = ?
       WHERE task_id = ? AND chat_id = ? AND status = 'open'`,
    ).run(`[event:${eventId}] ${resolution}`.slice(0, DEBT_MAX_STATEMENT), ts, taskId, input.chatId);
    return result.changes;
  } catch (err) {
    logger.warn({ err, taskId, chatId: input.chatId }, 'resolveOpenDebtsByTaskWithEvidence failed');
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
