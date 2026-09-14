// Durable AgencyAction runtime. This module fixes the execution contract but
// does not enable Core authority by itself: callers must explicitly provide an
// adapter for each action type and choose when to dispatch a run.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { appendCognitiveEvent } from './cognitive-events.js';
import { validateAgencyAction } from './agency.js';
import { evaluateAgencyPolicy } from './agency-policy.js';
import { scopeKey } from '../shared/cognitive-scope.js';
import type { AgencyAction } from './agency.js';
import type { CognitiveScope, ScopeVisibility } from '../shared/cognitive-scope.js';

export type AgencyRisk = 'read' | 'reversible' | 'irreversible';
export type AgencyRunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface AgencyBudget {
  maxMs: number;
  maxLlmCalls: number;
  maxToolCalls: number;
}

export interface AgencyActionEnvelope {
  id: string;
  correlationId: string;
  causationId?: string;
  scope: CognitiveScope;
  action: AgencyAction;
  risk: AgencyRisk;
  budget: AgencyBudget;
  expectedOutcome?: string;
  idempotencyKey: string;
  createdAt: number;
  expiresAt?: number;
}

export interface AgencyRun {
  id: string;
  envelope: AgencyActionEnvelope;
  status: AgencyRunStatus;
  attempt: number;
  result: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CreateAgencyEnvelopeInput {
  action: unknown;
  scope: CognitiveScope;
  idempotencyKey: string;
  correlationId?: string;
  causationId?: string;
  expectedOutcome?: string;
  budget?: Partial<AgencyBudget>;
  expiresAt?: number;
}

export interface AgencyEnvelopeValidation {
  ok: boolean;
  reason?: string;
  envelope?: AgencyActionEnvelope;
}

export interface AgencyRunResult {
  ok: boolean;
  run?: AgencyRun;
  reused?: boolean;
  reason?: string;
}

export interface AgencyRunSummary {
  id: string;
  correlationId: string;
  causationId: string | null;
  scopeKey: string;
  visibility: ScopeVisibility;
  chatId: number | null;
  userId: number | null;
  taskId: string | null;
  actionType: AgencyAction['type'];
  actionTarget: string | null;
  risk: AgencyRisk;
  idempotencyKey: string;
  status: AgencyRunStatus;
  attempt: number;
  maxMs: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface AgencyRunWindowInput {
  chatId?: number;
  since?: number;
  status?: AgencyRunStatus;
  limit?: number;
}

export interface ObservedAgencyOutcomeInput {
  runId: string;
  status: 'succeeded' | 'failed';
  result?: unknown;
  error?: string;
}

export interface AgencyAdapterContext {
  runId: string;
  attempt: number;
  correlationId: string;
  idempotencyKey: string;
  scope: CognitiveScope;
  signal: AbortSignal;
  budget: AgencyBudget;
  usage: AgencyUsage;
}

export type AgencyAdapter = (action: AgencyAction, context: AgencyAdapterContext) => unknown | Promise<unknown>;
export type AgencyAdapters = Partial<Record<AgencyAction['type'], AgencyAdapter>>;

/** Runtime counters adapters must consume before invoking LLM/tool side effects. */
export interface AgencyUsage {
  readonly llmCalls: number;
  readonly toolCalls: number;
  consumeLlmCall(): number;
  consumeToolCall(): number;
}

const DEFAULT_BUDGET: AgencyBudget = { maxMs: 30_000, maxLlmCalls: 1, maxToolCalls: 4 };
const activeControllers = new Map<string, AbortController>();

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasAgencyTable(db: ReturnType<typeof getDb>): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_runs'").get());
}

function hasTable(db: ReturnType<typeof getDb>, name: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name));
}

function actionRisk(action: AgencyAction): AgencyRisk {
  switch (action.type) {
    case 'observe':
      return 'read';
    case 'speak':
    case 'ask':
    case 'wait':
    case 'remember':
    case 'correct':
      return 'reversible';
    case 'act':
    case 'stop':
      return 'irreversible';
  }
}

function boundedText(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

function normalizeBudget(input?: Partial<AgencyBudget>): AgencyBudget | null {
  const values = { ...DEFAULT_BUDGET, ...input };
  if (!Number.isSafeInteger(values.maxMs) || values.maxMs < 100 || values.maxMs > 10 * 60_000) return null;
  if (!Number.isSafeInteger(values.maxLlmCalls) || values.maxLlmCalls < 0 || values.maxLlmCalls > 100) return null;
  if (!Number.isSafeInteger(values.maxToolCalls) || values.maxToolCalls < 0 || values.maxToolCalls > 100) return null;
  return values;
}

function validatePersistedEnvelope(envelope: AgencyActionEnvelope): string | null {
  if (!envelope || typeof envelope !== 'object') return 'invalid_envelope';
  if (typeof envelope.id !== 'string' || !envelope.id.trim() || envelope.id.length > 240) return 'invalid_envelope_id';
  if (typeof envelope.correlationId !== 'string' || !envelope.correlationId.trim() || envelope.correlationId.length > 240) return 'invalid_correlation_id';
  const action = validateAgencyAction(envelope.action);
  if (!action.ok || !action.action) return action.reason ?? 'invalid_action';
  if (!envelope.scope || envelope.scope.visibility === 'global' || envelope.scope.chatId === undefined || envelope.scope.chatId === 0) {
    return 'scoped_chat_required';
  }
  try {
    scopeKey(envelope.scope);
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid_scope';
  }
  if (envelope.risk !== actionRisk(action.action)) return 'risk_mismatch';
  if (typeof envelope.idempotencyKey !== 'string' || !envelope.idempotencyKey.trim() || envelope.idempotencyKey.length > 240) {
    return 'invalid_idempotency_key';
  }
  if (!Number.isSafeInteger(envelope.createdAt) || envelope.createdAt <= 0) return 'invalid_created_at';
  if (envelope.expiresAt !== undefined && (!Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= envelope.createdAt)) {
    return 'invalid_expiry';
  }
  if (!normalizeBudget(envelope.budget)) return 'invalid_budget';
  return null;
}

function createAgencyUsage(budget: AgencyBudget): AgencyUsage {
  let llmCalls = 0;
  let toolCalls = 0;
  return {
    get llmCalls() { return llmCalls; },
    get toolCalls() { return toolCalls; },
    consumeLlmCall() {
      if (llmCalls >= budget.maxLlmCalls) throw new Error('agency LLM budget exceeded');
      llmCalls += 1;
      return llmCalls;
    },
    consumeToolCall() {
      if (toolCalls >= budget.maxToolCalls) throw new Error('agency tool budget exceeded');
      toolCalls += 1;
      return toolCalls;
    },
  };
}

function persistAttemptStarted(run: AgencyRun): void {
  try {
    const db = getDb();
    if (!hasTable(db, 'agency_attempts')) return;
    db.prepare(
      `INSERT OR IGNORE INTO agency_attempts (run_id, attempt_no, status, started_at)
       VALUES (?, ?, 'running', ?)`,
    ).run(run.id, run.attempt, run.startedAt ?? nowSec());
  } catch (err) {
    logger.debug({ err, runId: run.id, attempt: run.attempt }, 'agency attempt start persist failed');
  }
}

function persistAttemptSettled(
  run: AgencyRun,
  status: 'succeeded' | 'failed' | 'cancelled' | 'expired',
  result: unknown,
  error: string | null,
): string | undefined {
  try {
    const db = getDb();
    if (!hasTable(db, 'agency_attempts') || !hasTable(db, 'execution_receipts')) return undefined;
    let resultJson: string | null = null;
    if (result !== undefined) {
      try {
        const serialized = JSON.stringify(result);
        resultJson = serialized.length <= 8000 ? serialized : JSON.stringify({ truncated: true, preview: serialized.slice(0, 7900) });
      } catch {
        resultJson = JSON.stringify({ unserializable: true });
      }
    }
    const ts = nowSec();
    db.prepare(
      `UPDATE agency_attempts SET status = ?, finished_at = ?, result_json = ?, error = ?
       WHERE run_id = ? AND attempt_no = ? AND status = 'running'`,
    ).run(status, ts, resultJson, error?.slice(0, 500) ?? null, run.id, run.attempt);
    const existing = db.prepare('SELECT id FROM execution_receipts WHERE run_id = ? AND attempt_id = (SELECT id FROM agency_attempts WHERE run_id = ? AND attempt_no = ?)').get(run.id, run.id, run.attempt) as { id?: string } | undefined;
    if (existing?.id) return existing.id;
    const receiptId = randomUUID();
    const attempt = db.prepare('SELECT id FROM agency_attempts WHERE run_id = ? AND attempt_no = ?').get(run.id, run.attempt) as { id?: number } | undefined;
    db.prepare(
      `INSERT OR IGNORE INTO execution_receipts (id, run_id, attempt_id, status, result_json, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(receiptId, run.id, attempt?.id ?? null, status, resultJson, error?.slice(0, 500) ?? null, ts);
    const inserted = db.prepare('SELECT id FROM execution_receipts WHERE run_id = ? AND attempt_id IS ?').get(run.id, attempt?.id ?? null) as { id?: string } | undefined;
    return inserted?.id ?? receiptId;
  } catch (err) {
    logger.debug({ err, runId: run.id, attempt: run.attempt, status }, 'agency execution receipt persist failed');
    return undefined;
  }
}

/** Build and validate a host-owned action envelope. */
export function createAgencyEnvelope(input: CreateAgencyEnvelopeInput): AgencyEnvelopeValidation {
  const action = validateAgencyAction(input.action);
  if (!action.ok || !action.action) return { ok: false, reason: action.reason ?? 'invalid_action' };
  if (!input.scope || input.scope.visibility === 'global' || input.scope.chatId === undefined || input.scope.chatId === 0) {
    return { ok: false, reason: 'scoped_chat_required' };
  }
  try {
    scopeKey(input.scope);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid_scope' };
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 240) return { ok: false, reason: 'invalid_idempotency_key' };
  const budget = normalizeBudget(input.budget);
  if (!budget) return { ok: false, reason: 'invalid_budget' };
  const createdAt = nowSec();
  const expiresAt = input.expiresAt;
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt)) return { ok: false, reason: 'invalid_expiry' };
  const id = randomUUID();
  const envelope: AgencyActionEnvelope = {
    id,
    correlationId: boundedText(input.correlationId, 240) ?? `agency:${id}`,
    ...(boundedText(input.causationId, 240) ? { causationId: boundedText(input.causationId, 240) } : {}),
    scope: input.scope,
    action: action.action,
    risk: actionRisk(action.action),
    budget,
    ...(boundedText(input.expectedOutcome, 500) ? { expectedOutcome: boundedText(input.expectedOutcome, 500) } : {}),
    idempotencyKey,
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  return { ok: true, envelope };
}

function rowToRun(row: Record<string, unknown>): AgencyRun {
  let action: AgencyAction = { type: 'observe', target: 'invalid persisted action' };
  try {
    const parsed = JSON.parse(String(row['action_json'])) as unknown;
    const checked = validateAgencyAction(parsed);
    if (checked.ok && checked.action) action = checked.action;
  } catch {
    /* keep fail-closed placeholder */
  }
  const scope: CognitiveScope = {
    visibility: row['visibility'] as ScopeVisibility,
    ...(row['chat_id'] !== null ? { chatId: Number(row['chat_id']) } : {}),
    ...(row['user_id'] !== null ? { userId: Number(row['user_id']) } : {}),
    ...(row['task_id'] !== null ? { taskId: String(row['task_id']) } : {}),
  };
  const envelope: AgencyActionEnvelope = {
    id: String(row['id']),
    correlationId: String(row['correlation_id']),
    ...(row['causation_id'] !== null ? { causationId: String(row['causation_id']) } : {}),
    scope,
    action,
    risk: row['risk'] as AgencyRisk,
    budget: { maxMs: Number(row['max_ms']), maxLlmCalls: Number(row['max_llm_calls']), maxToolCalls: Number(row['max_tool_calls']) },
    ...(row['expected_outcome'] !== null ? { expectedOutcome: String(row['expected_outcome']) } : {}),
    idempotencyKey: String(row['idempotency_key']),
    createdAt: Number(row['created_at']),
    ...(row['expires_at'] !== null ? { expiresAt: Number(row['expires_at']) } : {}),
  };
  let result: unknown = null;
  try { result = row['result_json'] === null ? null : JSON.parse(String(row['result_json'])); } catch { result = null; }
  return {
    id: String(row['id']),
    envelope,
    status: row['status'] as AgencyRunStatus,
    attempt: Number(row['attempt']),
    result,
    error: row['error'] === null ? null : String(row['error']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    startedAt: row['started_at'] === null ? null : Number(row['started_at']),
    finishedAt: row['finished_at'] === null ? null : Number(row['finished_at']),
  };
}

function resultMessageId(result: unknown): number | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const messageId = (result as Record<string, unknown>)['messageId'];
  return typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

function emitRunEvent(
  run: AgencyRun,
  state: string,
  usage?: AgencyUsage,
  receiptId?: string,
  observed = false,
): void {
  try {
    appendCognitiveEvent({
      type: state === 'succeeded' && (run.envelope.action.type === 'speak' || run.envelope.action.type === 'ask') ? 'bot_delivery' : 'task_observation',
      source: 'host',
      scope: run.envelope.scope,
      correlationId: run.envelope.correlationId,
      causationId: run.envelope.causationId,
      dedupeKey: `agency-run:${run.id}:${state}:${run.attempt}`,
      fact: {
        runId: run.id,
        actionType: run.envelope.action.type,
        state,
        attempt: run.attempt,
        error: run.error,
        llmCalls: usage?.llmCalls ?? null,
        toolCalls: usage?.toolCalls ?? null,
        maxLlmCalls: run.envelope.budget.maxLlmCalls,
        maxToolCalls: run.envelope.budget.maxToolCalls,
        messageId: state === 'succeeded' ? resultMessageId(run.result) : null,
        receiptId: receiptId ?? null,
        observed,
      },
    });
  } catch (err) {
    logger.debug({ err, runId: run.id }, 'agency event append failed');
  }
}

/** Persist an envelope; repeated idempotency keys return the original run. */
export function createAgencyRun(envelope: AgencyActionEnvelope): AgencyRunResult {
  const validationError = validatePersistedEnvelope(envelope);
  if (validationError) return { ok: false, reason: validationError };
  try {
    const db = getDb();
    if (!hasAgencyTable(db)) return { ok: false, reason: 'agency_runs_unavailable' };
    const existing = db.prepare('SELECT * FROM agency_runs WHERE idempotency_key = ?').get(envelope.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { ok: true, reused: true, run: rowToRun(existing) };
    const ts = nowSec();
    db.prepare(
      `INSERT INTO agency_runs
         (id, correlation_id, causation_id, scope_key, visibility, chat_id, user_id, task_id,
          action_json, risk, idempotency_key, expected_outcome, max_ms, max_llm_calls,
          max_tool_calls, expires_at, status, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).run(
      envelope.id,
      envelope.correlationId,
      envelope.causationId ?? null,
      scopeKey(envelope.scope),
      envelope.scope.visibility,
      envelope.scope.chatId ?? null,
      envelope.scope.userId ?? null,
      envelope.scope.taskId ?? null,
      JSON.stringify(envelope.action),
      envelope.risk,
      envelope.idempotencyKey,
      envelope.expectedOutcome ?? null,
      envelope.budget.maxMs,
      envelope.budget.maxLlmCalls,
      envelope.budget.maxToolCalls,
      envelope.expiresAt ?? null,
      ts,
      ts,
    );
    const row = db.prepare('SELECT * FROM agency_runs WHERE id = ?').get(envelope.id) as Record<string, unknown>;
    const run = rowToRun(row);
    emitRunEvent(run, 'pending');
    return { ok: true, run };
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: agency_runs.idempotency_key')) {
      const existing = getDb().prepare('SELECT * FROM agency_runs WHERE idempotency_key = ?').get(envelope.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return { ok: true, reused: true, run: rowToRun(existing) };
    }
    logger.warn({ err, idempotencyKey: envelope.idempotencyKey }, 'agency run create failed');
    return { ok: false, reason: 'agency_runs_error' };
  }
}

export function getAgencyRun(id: string): AgencyRun | null {
  try {
    const row = getDb().prepare('SELECT * FROM agency_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  } catch { return null; }
}

export function listAgencyRuns(scope?: CognitiveScope, limit = 50): AgencyRun[] {
  try {
    const db = getDb();
    const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
    if (scope) {
      const rows = db.prepare('SELECT * FROM agency_runs WHERE scope_key = ? ORDER BY created_at DESC LIMIT ?').all(scopeKey(scope), take) as Record<string, unknown>[];
      return rows.map(rowToRun);
    }
    return (db.prepare('SELECT * FROM agency_runs ORDER BY created_at DESC LIMIT ?').all(take) as Record<string, unknown>[]).map(rowToRun);
  } catch { return []; }
}

/**
 * Return redacted Agency lifecycle metadata for operational inspection.
 * Action arguments, message text, goals, and adapter results are intentionally
 * omitted so a monitor endpoint cannot become a second content store.
 */
export function listAgencyRunSummaries(input: AgencyRunWindowInput = {}): AgencyRunSummary[] {
  if (input.chatId !== undefined && (!Number.isSafeInteger(input.chatId) || input.chatId === 0)) return [];
  if (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since <= 0)) return [];
  if (input.status !== undefined && !['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'expired'].includes(input.status)) return [];
  try {
    const db = getDb();
    if (!hasAgencyTable(db)) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.chatId !== undefined) { clauses.push('chat_id = ?'); params.push(input.chatId); }
    if (input.since !== undefined) { clauses.push('created_at >= ?'); params.push(input.since); }
    if (input.status !== undefined) { clauses.push('status = ?'); params.push(input.status); }
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT id, correlation_id, causation_id, scope_key, visibility, chat_id, user_id,
              task_id, action_json, risk, idempotency_key, status, attempt, max_ms,
              max_llm_calls, max_tool_calls, error, created_at, updated_at, started_at,
              finished_at
         FROM agency_runs ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let actionType: AgencyAction['type'] = 'observe';
      let actionTarget: string | null = null;
      try {
        const parsed = JSON.parse(String(row['action_json'])) as unknown;
        const checked = validateAgencyAction(parsed);
        if (checked.ok && checked.action) {
          actionType = checked.action.type;
          actionTarget = checked.action.type === 'observe' ? checked.action.target : null;
        }
      } catch {
        /* Preserve a redacted, fail-closed summary for malformed rows. */
      }
      return {
        id: String(row['id']),
        correlationId: String(row['correlation_id']),
        causationId: row['causation_id'] === null ? null : String(row['causation_id']),
        scopeKey: String(row['scope_key']),
        visibility: row['visibility'] as ScopeVisibility,
        chatId: row['chat_id'] === null ? null : Number(row['chat_id']),
        userId: row['user_id'] === null ? null : Number(row['user_id']),
        taskId: row['task_id'] === null ? null : String(row['task_id']),
        actionType,
        actionTarget,
        risk: row['risk'] as AgencyRisk,
        idempotencyKey: String(row['idempotency_key']),
        status: row['status'] as AgencyRunStatus,
        attempt: Number(row['attempt']),
        maxMs: Number(row['max_ms']),
        maxLlmCalls: Number(row['max_llm_calls']),
        maxToolCalls: Number(row['max_tool_calls']),
        error: row['error'] === null ? null : String(row['error']).slice(0, 500),
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
        startedAt: row['started_at'] === null ? null : Number(row['started_at']),
        finishedAt: row['finished_at'] === null ? null : Number(row['finished_at']),
      } satisfies AgencyRunSummary;
    });
  } catch (err) {
    logger.debug({ err }, 'agency run summary window read failed');
    return [];
  }
}

/** Cancel before adapter completion. A running adapter receives AbortSignal. */
export function cancelAgencyRun(id: string, reason = 'cancelled'): AgencyRunResult {
  try {
    activeControllers.get(id)?.abort();
    const db = getDb();
    const ts = nowSec();
    const result = db.prepare(
      `UPDATE agency_runs SET status = 'cancelled', error = ?, updated_at = ?, finished_at = ?
       WHERE id = ? AND status IN ('pending','running','waiting')`,
    ).run(reason.trim().slice(0, 500), ts, ts, id);
    const run = getAgencyRun(id);
    if (!run) return { ok: false, reason: 'run not found' };
    if (result.changes === 1) {
      const receiptId = persistAttemptSettled(run, 'cancelled', null, run.error);
      emitRunEvent(run, 'cancelled', undefined, receiptId);
    }
    return { ok: result.changes === 1, run, reason: result.changes === 1 ? undefined : 'run not cancellable' };
  } catch { return { ok: false, reason: 'agency_runs_error' }; }
}

function deferAgencyRun(id: string, reason: string): AgencyRunResult {
  try {
    const db = getDb();
    const ts = nowSec();
    const changed = db.prepare(
      `UPDATE agency_runs SET status = 'waiting', error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending','waiting')`,
    ).run(`policy:${reason}`.slice(0, 500), ts, id);
    const run = getAgencyRun(id);
    if (!run) return { ok: false, reason: 'run not found' };
    if (changed.changes === 1) emitRunEvent(run, 'waiting');
    return { ok: false, run, reason: `policy:${reason}` };
  } catch {
    return { ok: false, reason: 'agency_runs_error' };
  }
}

/**
 * Policy-gated dispatch entry point. `executeAgencyRun` remains the lower-level
 * host primitive for tests and already-authorized adapters; production callers
 * should use this function so rollout mode cannot be bypassed accidentally.
 */
export async function dispatchAgencyRun(id: string, adapters: AgencyAdapters): Promise<AgencyRunResult> {
  const run = getAgencyRun(id);
  if (!run) return { ok: false, reason: 'run not found' };
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'expired') {
    return executeAgencyRun(id, adapters);
  }
  const policy = evaluateAgencyPolicy({
    scope: run.envelope.scope,
    action: run.envelope.action,
    risk: run.envelope.risk,
    budget: {
      maxLlmCalls: run.envelope.budget.maxLlmCalls,
      maxToolCalls: run.envelope.budget.maxToolCalls,
    },
  });
  if (!policy.allowed) return deferAgencyRun(id, policy.reason ?? 'policy_denied');
  return executeAgencyRun(id, adapters);
}

/** Dispatch one pending run through an explicitly supplied adapter. */
export async function executeAgencyRun(id: string, adapters: AgencyAdapters): Promise<AgencyRunResult> {
  const initial = getAgencyRun(id);
  if (!initial) return { ok: false, reason: 'run not found' };
  if (initial.status === 'succeeded' || initial.status === 'failed' || initial.status === 'cancelled' || initial.status === 'expired') {
    return { ok: initial.status === 'succeeded', run: initial, reason: initial.status };
  }
  if (initial.envelope.expiresAt !== undefined && initial.envelope.expiresAt <= nowSec()) {
    const db = getDb();
    const expiredAt = nowSec();
    const changed = db.prepare(`UPDATE agency_runs SET status = 'expired', error = 'envelope expired', updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('pending','waiting')`).run(expiredAt, expiredAt, id);
    const expired = getAgencyRun(id);
    if (changed.changes === 1 && expired) {
      const receiptId = persistAttemptSettled(expired, 'expired', null, expired.error);
      emitRunEvent(expired, 'expired', undefined, receiptId);
    }
    return {
      ok: false,
      run: expired ?? initial,
      reason: changed.changes === 1 ? 'expired' : expired?.status ?? 'run already claimed',
    };
  }
  const db = getDb();
  const started = nowSec();
  const claimed = db.prepare(
    `UPDATE agency_runs SET status = 'running', attempt = attempt + 1, started_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('pending','waiting')`,
  ).run(started, started, id);
  if (claimed.changes !== 1) {
    const current = getAgencyRun(id);
    return { ok: false, run: current ?? undefined, reason: 'run already claimed' };
  }
  const running = getAgencyRun(id)!;
  persistAttemptStarted(running);
  // Runtime callers may come from JS/admin code, so treat a malformed adapter
  // map as an unavailable capability instead of leaving the claimed run stuck.
  const adapter = adapters && typeof adapters === 'object'
    ? adapters[running.envelope.action.type]
    : undefined;
  if (!adapter) {
    db.prepare(`UPDATE agency_runs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ?`).run(`no adapter for ${running.envelope.action.type}`, nowSec(), nowSec(), id);
    const failed = getAgencyRun(id)!;
    const receiptId = persistAttemptSettled(failed, 'failed', null, failed.error);
    emitRunEvent(failed, 'failed', undefined, receiptId);
    return { ok: false, run: failed, reason: failed.error ?? 'no adapter' };
  }
  const controller = new AbortController();
  activeControllers.set(id, controller);
  const usage = createAgencyUsage(running.envelope.budget);
  let timeoutTriggered = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const resultPromise = Promise.resolve().then(() => adapter(running.envelope.action, {
      runId: id,
      attempt: running.attempt,
      correlationId: running.envelope.correlationId,
      idempotencyKey: running.envelope.idempotencyKey,
      scope: running.envelope.scope,
      signal: controller.signal,
      budget: running.envelope.budget,
      usage,
    }));
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
        reject(new Error('agency budget timeout'));
      }, running.envelope.budget.maxMs);
    });
    const result = await Promise.race([resultPromise, timeoutPromise]);
    if (usage.llmCalls > running.envelope.budget.maxLlmCalls || usage.toolCalls > running.envelope.budget.maxToolCalls) {
      throw new Error('agency budget exceeded');
    }
    let resultJson: string;
    try {
      const serialized = JSON.stringify(result ?? null);
      resultJson = serialized.length <= 8000 ? serialized : JSON.stringify({ truncated: true, preview: serialized.slice(0, 7900) });
    } catch {
      resultJson = JSON.stringify({ unserializable: true });
    }
    const settledAt = nowSec();
    const updated = db.prepare(`UPDATE agency_runs SET status = 'succeeded', result_json = ?, error = NULL, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'`).run(resultJson, settledAt, settledAt, id);
    const succeeded = getAgencyRun(id)!;
    if (updated.changes !== 1) return { ok: false, run: succeeded, reason: succeeded.status };
    const receiptId = persistAttemptSettled(succeeded, 'succeeded', result, null);
    emitRunEvent(succeeded, 'succeeded', usage, receiptId);
    return { ok: true, run: succeeded };
  } catch (err) {
    const reason = timeoutTriggered ? 'agency budget timeout' : controller.signal.aborted ? 'agency run cancelled' : err instanceof Error ? err.message : String(err);
    const failedAt = nowSec();
    const updated = db.prepare(`UPDATE agency_runs SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'`).run(reason.slice(0, 500), failedAt, failedAt, id);
    const failed = getAgencyRun(id)!;
    if (updated.changes === 1) {
      const receiptId = persistAttemptSettled(failed, 'failed', null, reason);
      emitRunEvent(failed, 'failed', usage, receiptId);
    }
    return { ok: false, run: failed, reason };
  } finally {
    if (timeout) clearTimeout(timeout);
    activeControllers.delete(id);
  }
}

/**
 * Settle a speak/ask run from a host-observed delivery that already happened
 * outside Agency. This records the actual receipt without invoking a sender,
 * so legacy paths can become auditable before any Agency authority rollout.
 */
export function recordObservedAgencyOutcome(input: ObservedAgencyOutcomeInput): AgencyRunResult {
  if (input.status !== 'succeeded' && input.status !== 'failed') {
    return { ok: false, reason: 'invalid observed outcome status' };
  }
  const initial = getAgencyRun(input.runId);
  if (!initial) return { ok: false, reason: 'run not found' };
  if (initial.status === 'succeeded' || initial.status === 'failed' || initial.status === 'cancelled' || initial.status === 'expired') {
    return { ok: initial.status === 'succeeded', run: initial, reason: initial.status };
  }
  if (initial.envelope.action.type !== 'speak' && initial.envelope.action.type !== 'ask') {
    return { ok: false, run: initial, reason: 'observed outcome only supports speak/ask' };
  }
  if (input.status === 'succeeded' && resultMessageId(input.result) === null) {
    return { ok: false, run: initial, reason: 'observed delivery requires a valid messageId' };
  }
  const error = typeof input.error === 'string' ? input.error.trim().slice(0, 500) || null : null;
  if (input.status === 'failed' && !error) {
    return { ok: false, run: initial, reason: 'observed failure requires an error' };
  }

  try {
    const db = getDb();
    const started = nowSec();
    const claimed = db.prepare(
      `UPDATE agency_runs SET status = 'running', attempt = attempt + 1, started_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending','waiting')`,
    ).run(started, started, input.runId);
    if (claimed.changes !== 1) {
      const current = getAgencyRun(input.runId);
      return { ok: false, run: current ?? undefined, reason: 'run already claimed' };
    }

    const running = getAgencyRun(input.runId);
    if (!running) return { ok: false, reason: 'run disappeared after claim' };
    persistAttemptStarted(running);

    let resultJson: string | null = null;
    if (input.result !== undefined) {
      try {
        const serialized = JSON.stringify(input.result);
        resultJson = serialized.length <= 8000
          ? serialized
          : JSON.stringify({ truncated: true, preview: serialized.slice(0, 7900) });
      } catch {
        resultJson = JSON.stringify({ unserializable: true });
      }
    }
    const settledAt = nowSec();
    const updated = db.prepare(
      `UPDATE agency_runs SET status = ?, result_json = ?, error = ?, updated_at = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(input.status, resultJson, error, settledAt, settledAt, input.runId);
    const settled = getAgencyRun(input.runId);
    if (!settled) return { ok: false, reason: 'run disappeared after settlement' };
    if (updated.changes !== 1) return { ok: false, run: settled, reason: settled.status };

    const receiptId = persistAttemptSettled(settled, input.status, input.result, error);
    emitRunEvent(settled, input.status, undefined, receiptId, true);
    return { ok: input.status === 'succeeded', run: settled, reason: input.status === 'failed' ? error ?? 'observed failure' : undefined };
  } catch (err) {
    logger.warn({ err, runId: input.runId }, 'observed agency outcome persist failed');
    return { ok: false, run: getAgencyRun(input.runId) ?? initial, reason: 'agency_runs_error' };
  }
}
