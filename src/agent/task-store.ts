// ────────────────────────────────────────
// Task store — AGI Level 6 Phase 13
// 任务对象 CRUD + 状态机。BullMQ 任务队列的数据层。
//
// 安全铁律: Task 创建权限收紧 —— 只有被 @ 的直接请求能建(createTask 的
// requireMention 由调用方保证,这里只存数据)。
// ────────────────────────────────────────
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { cancelAgencyRun } from './agency-runtime.js';
import { findConversationRef, findUserRef, isPlatformInternalId } from '../platform/identity-store.js';

export type TaskState = 'pending' | 'running' | 'blocked' | 'waiting_user' | 'done' | 'cancelled';
export type TaskKind = 'research' | 'monitor' | 'summarize';

export interface TaskRow {
  id: number;
  owner_uid: number;
  chat_id: number;
  goal: string;
  kind: TaskKind;
  state: TaskState;
  ledger: string;      // JSON array
  progress: string;    // JSON array
  next_wake: number | null;
  wake_trigger: string | null;
  result: string | null;
  search_round: number;
  max_rounds: number;
  retry_count: number;
  created_at: number;
  updated_at: number;
  source_platform: string | null;
  source_account_id: string | null;
  execution_version: number;
  cancel_generation: number;
  wake_generation: number;
  claim_owner: string | null;
  claim_until_ms: number | null;
  agency_run_id: string | null;
  delivery_state: 'none' | 'sending' | 'sent' | 'failed' | 'suppressed' | 'unknown';
  delivery_version: number | null;
  delivery_receipt: string | null;
}

export interface LedgerEntry {
  step: string;
  result: string;
  ts: number;
}

/** 失败重试退避(分钟): 15min → 2h → 1d,上限 3 次后放弃。 */
export const RETRY_BACKOFF_MIN = [15, 120, 1440] as const;
export const MAX_RETRIES = RETRY_BACKOFF_MIN.length;

const nowSec = (): number => Math.floor(Date.now() / 1000);

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as number,
    owner_uid: r.owner_uid as number,
    chat_id: r.chat_id as number,
    goal: r.goal as string,
    kind: r.kind as TaskKind,
    state: r.state as TaskState,
    ledger: r.ledger as string,
    progress: r.progress as string,
    next_wake: r.next_wake as number | null,
    wake_trigger: r.wake_trigger as string | null,
    result: r.result as string | null,
    search_round: r.search_round as number,
    max_rounds: r.max_rounds as number,
    retry_count: r.retry_count as number,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    source_platform: r.source_platform as string | null,
    source_account_id: r.source_account_id as string | null,
    execution_version: Number(r.execution_version),
    cancel_generation: Number(r.cancel_generation),
    wake_generation: Number(r.wake_generation),
    claim_owner: r.claim_owner as string | null,
    claim_until_ms: r.claim_until_ms as number | null,
    agency_run_id: r.agency_run_id as string | null,
    delivery_state: r.delivery_state as TaskRow['delivery_state'],
    delivery_version: r.delivery_version as number | null,
    delivery_receipt: r.delivery_receipt as string | null,
  };
}

/** 建任务(调用方已确认用户 @ 了 bot 且是直接请求)。返回 task id。 */
/** TASK_MAX_ROUNDS；env 不可用时退回 6（与改动前一致）。 */
function readMaxRounds(): number {
  try {
    const n = Number(env().TASK_MAX_ROUNDS ?? 6);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
  } catch {
    return 6;
  }
}

export function createTask(input: {
  ownerUid: number;
  chatId: number;
  goal: string;
  kind?: TaskKind;
  maxRounds?: number;
}): number {
  const ts = nowSec();
  const kind = input.kind ?? 'research';
  // maxRounds 未显式传入时读 env（TASK_MAX_ROUNDS，默认 6）。
  //
  // 2026-09-21：这个旗标声明了而全仓库没有一处读它——唯一的调用方
  // （pipeline/judge/task-trigger.ts 的 createTask）不传 maxRounds，
  // 于是永远落在这里的硬编码 6。值恰好等于旗标默认值，接上不改变行为。
  const maxRounds = input.maxRounds ?? readMaxRounds();
  const scope = resolveConversationScope(input.chatId);
  if (!scope || !Number.isSafeInteger(input.ownerUid) || input.ownerUid <= 0) throw new Error('invalid research task scope');
  const r = getDb()
    .prepare(
      `INSERT INTO tasks (owner_uid, chat_id, goal, kind, state, ledger, progress, search_round, max_rounds, created_at, updated_at,
        next_wake, source_platform, source_account_id)
       VALUES (?, ?, ?, ?, 'pending', '[]', '[]', 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.ownerUid, input.chatId, input.goal, kind, maxRounds, ts, ts, ts, scope.platform, scope.accountId);
  return Number(r.lastInsertRowid);
}

export function getTask(id: number): TaskRow | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** 某用户的活跃任务(pending/running/blocked/waiting_user)。 */
export function listActiveTasks(ownerUid: number, chatId: number): TaskRow[] {
  const activationEpoch = env().PROACTIVE_ACTIVATED_AT_SEC ?? 0;
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE owner_uid = ? AND chat_id = ? AND state IN ('pending','running','blocked','waiting_user')
       AND (? = 0 OR created_at > ?)
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(ownerUid, chatId, activationEpoch, activationEpoch) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** 到点该唤醒的任务(定时)。 */
export function listDueTasks(now = nowSec()): TaskRow[] {
  const activationEpoch = env().PROACTIVE_ACTIVATED_AT_SEC ?? 0;
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE ((state IN ('pending','blocked','waiting_user') AND next_wake IS NOT NULL AND next_wake <= ?)
        OR (state = 'running' AND claim_until_ms <= ?))
       AND (? = 0 OR created_at > ?) ORDER BY id`,
    )
    .all(now, now * 1000, activationEpoch, activationEpoch) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function setTaskState(id: number, state: TaskState): void {
  getDb()
    .prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND state NOT IN ('done','cancelled') AND claim_owner IS NULL`)
    .run(state, nowSec(), id);
}

/** 追加事实台账条目(已做的步骤 + 结果)。 */
export function appendLedger(id: number, entry: LedgerEntry): void {
  const t = getTask(id);
  if (!t) return;
  let arr: LedgerEntry[] = [];
  try {
    arr = JSON.parse(t.ledger) as LedgerEntry[];
  } catch {
    arr = [];
  }
  arr.push(entry);
  // 防无界增长: 只留最近 40 条
  if (arr.length > 40) arr = arr.slice(-40);
  getDb()
    .prepare(`UPDATE tasks SET ledger = ?, updated_at = ? WHERE id = ? AND state NOT IN ('done','cancelled')`)
    .run(JSON.stringify(arr), nowSec(), id);
}

/** 设置进度台账(还差什么/卡在哪)。 */
export function setProgress(id: number, progress: string[]): void {
  getDb()
    .prepare(`UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ? AND state NOT IN ('done','cancelled')`)
    .run(JSON.stringify(progress.slice(0, 20)), nowSec(), id);
}

/** 搜索轮次推进。返回是否达到上限(调用方决定 stop)。 */
export function bumpSearchRound(id: number): { round: number; done: boolean } {
  const t = getTask(id);
  if (!t) return { round: 0, done: true };
  const round = t.search_round + 1;
  const done = round >= t.max_rounds;
  getDb()
    .prepare(`UPDATE tasks SET search_round = ?, updated_at = ? WHERE id = ? AND state NOT IN ('done','cancelled') AND claim_owner IS NULL`)
    .run(round, nowSec(), id);
  return { round, done };
}

/** 完成: 写结果 + 状态 done + 清唤醒。 */
export function completeTask(id: number, result: string): void {
  getDb()
    .prepare(`UPDATE tasks SET result = ?, state = 'done', next_wake = NULL, wake_trigger = NULL, updated_at = ?
      WHERE id = ? AND state NOT IN ('done','cancelled') AND claim_owner IS NULL`)
    .run(result, nowSec(), id);
}

/** 计划下一次唤醒(定时)。 */
export function scheduleWake(id: number, nextWakeTs: number, trigger?: string): void {
  getDb()
    .prepare(`UPDATE tasks SET next_wake = ?, wake_trigger = ?, wake_generation = wake_generation + 1, updated_at = ?
      WHERE id = ? AND state NOT IN ('done','cancelled') AND claim_owner IS NULL`)
    .run(nextWakeTs, trigger ?? null, nowSec(), id);
}

/** 清理: 取消任务。 */
export function cancelTask(id: number): void {
  const task = getTask(id);
  const changed = getDb()
    .prepare(`UPDATE tasks SET state = 'cancelled', cancel_generation = cancel_generation + 1,
      claim_owner = NULL, claim_until_ms = NULL, next_wake = NULL, wake_trigger = NULL, updated_at = ?
      WHERE id = ? AND state NOT IN ('done','cancelled')`)
    .run(nowSec(), id);
  if (changed.changes && task?.agency_run_id) cancelAgencyRun(task.agency_run_id, 'research_cancelled');
}

/**
 * 失败退避重试: 递增 retry_count,按 15min/2h/1d 安排 next_wake。
 * 返回 true = 已安排重试;false = 达到上限(调用方应发"放弃了"文案并终止)。
 */
export function retryTask(id: number): boolean {
  const t = getTask(id);
  if (!t || t.state === 'done' || t.state === 'cancelled' || t.claim_owner) return false;
  const next = t.retry_count + 1;
  if (next > MAX_RETRIES) {
    // 放弃: 终止任务,防止 listDueTasks 无限重派
    getDb()
      .prepare(`UPDATE tasks SET state = 'blocked', next_wake = NULL, retry_count = ?, updated_at = ?
        WHERE id = ? AND state NOT IN ('done','cancelled') AND claim_owner IS NULL`)
      .run(next, nowSec(), id);
    return false;
  }
  const delayMin = RETRY_BACKOFF_MIN[next - 1] ?? 1440;
  getDb()
    .prepare(`UPDATE tasks SET state = 'pending', next_wake = ?, retry_count = ?, wake_generation = wake_generation + 1, updated_at = ?
      WHERE id = ? AND state NOT IN ('done','cancelled') AND claim_owner IS NULL`)
    .run(nowSec() + delayMin * 60, next, nowSec(), id);
  return true;
}

/** 是否有活跃任务(judge L0 用)。 */
export function hasActiveTask(ownerUid: number, chatId: number): boolean {
  return listActiveTasks(ownerUid, chatId).length > 0;
}

/** env 门控。 */
export function tasksEnabled(): boolean {
  return env().TASK_EXECUTOR_ENABLED;
}

export interface TaskClaim {
  taskId: number;
  owner: string;
  version: number;
  cancelGeneration: number;
  wakeGeneration: number;
}

export interface ResearchStep<T = unknown> {
  key: string;
  input: unknown;
  result: T;
}

export const RESEARCH_LEASE_MS = 120_000;

function currentTaskScope(task: TaskRow): boolean {
  const scope = resolveConversationScope(task.chat_id);
  if (!scope?.accountId || scope.platform !== task.source_platform || scope.accountId !== task.source_account_id) return false;
  if (scope.platform === 'telegram') return task.owner_uid > 0 && !isPlatformInternalId(task.owner_uid)
    && (scope.conversationKind !== 'private' || task.owner_uid === task.chat_id);
  if (env().ONEBOT_ENABLED !== true || env().ONEBOT_ACCOUNT_ID !== scope.accountId) return false;
  const chat = findConversationRef(task.chat_id), user = findUserRef(task.owner_uid);
  return !!chat && !!user && user.platform === 'qq' && user.accountId === chat.accountId
    && user.idNamespace === chat.idNamespace && (chat.conversationKind !== 'private' || chat.id === user.id);
}

/** Stable per-wake queue identity. SQLite ownership remains the final fence. */
export function researchJobId(task: Pick<TaskRow, 'id' | 'wake_generation'>): string {
  return `research-${task.id}-wake-${task.wake_generation}`;
}

/** Claim only the persisted destination and generation; stale/forged jobs cannot redirect work. */
export function claimResearchTask(input: {
  taskId: number; chatId: number; ownerUid: number; wakeGeneration: number; owner: string; nowMs?: number;
}): TaskClaim | null {
  const now = input.nowMs ?? Date.now();
  const owner = input.owner.trim().slice(0, 160);
  if (!owner) return null;
  return getDb().transaction(() => {
    const task = getTask(input.taskId);
    if (!task || task.chat_id !== input.chatId || task.owner_uid !== input.ownerUid
      || task.wake_generation !== input.wakeGeneration || !currentTaskScope(task)
      || task.state === 'done' || task.state === 'cancelled'
      || (task.claim_until_ms !== null && task.claim_until_ms > now)
      || (task.next_wake !== null && task.next_wake * 1000 > now)
      || (['blocked', 'waiting_user'].includes(task.state) && task.next_wake === null)) return null;
    // A process died while sending. There is no proof that the peer did not
    // accept it: retain the result and wait for reconciliation, never replay.
    if (task.delivery_state === 'sending' || task.delivery_state === 'unknown') {
      getDb().prepare(`UPDATE tasks SET state = 'blocked', delivery_state = 'unknown',
        claim_owner = NULL, claim_until_ms = NULL, next_wake = NULL, updated_at = ? WHERE id = ?`)
        .run(nowSec(), task.id);
      if (task.agency_run_id) cancelAgencyRun(task.agency_run_id, 'research_delivery_unknown');
      return null;
    }
    if (task.agency_run_id) cancelAgencyRun(task.agency_run_id, 'research_owner_expired');
    const version = task.execution_version + 1;
    const changed = getDb().prepare(`UPDATE tasks SET state = 'running', claim_owner = ?, claim_until_ms = ?,
      execution_version = ?, next_wake = NULL, agency_run_id = NULL, updated_at = ?
      WHERE id = ? AND execution_version = ? AND cancel_generation = ? AND wake_generation = ?
        AND state NOT IN ('done','cancelled') AND (claim_until_ms IS NULL OR claim_until_ms <= ?)`)
      .run(owner, now + RESEARCH_LEASE_MS, version, nowSec(), task.id,
        task.execution_version, task.cancel_generation, task.wake_generation, now);
    return changed.changes === 1 ? { taskId: task.id, owner, version,
      cancelGeneration: task.cancel_generation, wakeGeneration: task.wake_generation } : null;
  })();
}

const CLAIM_WHERE = `id = ? AND state = 'running' AND claim_owner = ? AND execution_version = ?
  AND cancel_generation = ? AND wake_generation = ? AND claim_until_ms > ?`;
function claimParams(claim: TaskClaim, now = Date.now()): Array<string | number> {
  return [claim.taskId, claim.owner, claim.version, claim.cancelGeneration, claim.wakeGeneration, now];
}

export function isResearchClaimCurrent(claim: TaskClaim): boolean {
  const task = getTask(claim.taskId);
  return !!task && currentTaskScope(task) && task.state === 'running' && task.claim_owner === claim.owner
    && task.execution_version === claim.version && task.cancel_generation === claim.cancelGeneration
    && task.wake_generation === claim.wakeGeneration && (task.claim_until_ms ?? 0) > Date.now();
}

export function renewResearchClaim(claim: TaskClaim): boolean {
  if (!isResearchClaimCurrent(claim)) return false;
  return getDb().prepare(`UPDATE tasks SET claim_until_ms = ? WHERE ${CLAIM_WHERE}`)
    .run(Date.now() + RESEARCH_LEASE_MS, ...claimParams(claim)).changes === 1;
}

export function bindResearchAgency(claim: TaskClaim, runId: string): boolean {
  return getDb().prepare(`UPDATE tasks SET agency_run_id = ? WHERE ${CLAIM_WHERE}`)
    .run(runId, ...claimParams(claim)).changes === 1;
}

export function listResearchSteps<T = unknown>(taskId: number): ResearchStep<T>[] {
  const rows = getDb().prepare(`SELECT step_key, input_json, result_json FROM research_task_steps WHERE task_id = ? ORDER BY step_key`)
    .all(taskId) as Array<{ step_key: string; input_json: string; result_json: string }>;
  return rows.map((row) => ({ key: row.step_key, input: JSON.parse(row.input_json) as unknown, result: JSON.parse(row.result_json) as T }));
}

/** Successful read-only steps and their full bounded result become durable together. */
export function saveResearchStep(claim: TaskClaim, step: ResearchStep, searchRound?: number): boolean {
  return getDb().transaction(() => {
    if (!isResearchClaimCurrent(claim)) return false;
    const input = JSON.stringify(step.input), result = JSON.stringify(step.result);
    if (input.length > 24_000 || result.length > 100_000) throw new Error('research step exceeds storage budget');
    getDb().prepare(`INSERT OR IGNORE INTO research_task_steps (task_id, step_key, input_json, result_json, completed_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(claim.taskId, step.key, input, result, nowSec());
    if (searchRound !== undefined) getDb().prepare(`UPDATE tasks SET search_round = MAX(search_round, ?), updated_at = ? WHERE ${CLAIM_WHERE}`)
      .run(searchRound, nowSec(), ...claimParams(claim));
    return true;
  })();
}

export function beginResearchDelivery(claim: TaskClaim): boolean {
  if (!isResearchClaimCurrent(claim)) return false;
  return getDb().prepare(`UPDATE tasks SET delivery_state = 'sending', delivery_version = ?, delivery_receipt = NULL
    WHERE ${CLAIM_WHERE} AND delivery_state IN ('none','failed','suppressed')`)
    .run(claim.version, ...claimParams(claim)).changes === 1;
}

/** Preserve observed receipts even when cancellation races an already-started RPC. */
export function recordResearchDelivery(claim: TaskClaim, status: 'sent' | 'failed' | 'suppressed' | 'unknown', receipt: unknown): boolean {
  const serialized = JSON.stringify(receipt);
  if (serialized.length > 100_000) throw new Error('research receipt exceeds storage budget');
  return getDb().prepare(`UPDATE tasks SET delivery_state = ?, delivery_receipt = ?
    WHERE id = ? AND delivery_version = ? AND delivery_state IN ('sending','unknown')`)
    .run(status, serialized, claim.taskId, claim.version).changes === 1;
}

export function completeResearchClaim(claim: TaskClaim, result: string): boolean {
  if (!isResearchClaimCurrent(claim)) return false;
  return getDb().prepare(`UPDATE tasks SET state = 'done', result = ?, next_wake = NULL, wake_trigger = NULL,
    claim_owner = NULL, claim_until_ms = NULL, updated_at = ? WHERE ${CLAIM_WHERE} AND delivery_state = 'sent'`)
    .run(result, nowSec(), ...claimParams(claim)).changes === 1;
}

/** Failure changes only this owner epoch; cancellation and successor claims win. */
export function failResearchClaim(claim: TaskClaim, reason: string, hold = false): 'retry' | 'blocked' | 'stale' {
  return getDb().transaction(() => {
    if (!isResearchClaimCurrent(claim)) return 'stale';
    const task = getTask(claim.taskId)!;
    const retry = task.retry_count + 1;
    const blocked = hold || retry > MAX_RETRIES || task.delivery_state === 'unknown' || task.delivery_state === 'sending';
    const changed = getDb().prepare(`UPDATE tasks SET state = ?, retry_count = ?, next_wake = ?, wake_generation = wake_generation + 1,
      claim_owner = NULL, claim_until_ms = NULL, progress = ?, updated_at = ? WHERE ${CLAIM_WHERE}`)
      .run(blocked ? 'blocked' : 'pending', retry,
        blocked ? null : nowSec() + (RETRY_BACKOFF_MIN[retry - 1] ?? 1440) * 60,
        JSON.stringify([reason.slice(0, 240)]), nowSec(), ...claimParams(claim));
    return changed.changes !== 1 ? 'stale' : blocked ? 'blocked' : 'retry';
  })();
}
