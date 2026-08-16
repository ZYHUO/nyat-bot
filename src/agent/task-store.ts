// ────────────────────────────────────────
// Task store — AGI Level 6 Phase 13
// 任务对象 CRUD + 状态机。BullMQ 任务队列的数据层。
//
// 安全铁律: Task 创建权限收紧 —— 只有被 @ 的直接请求能建(createTask 的
// requireMention 由调用方保证,这里只存数据)。
// ────────────────────────────────────────
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';

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
  created_at: number;
  updated_at: number;
}

export interface LedgerEntry {
  step: string;
  result: string;
  ts: number;
}

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
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
  };
}

/** 建任务(调用方已确认用户 @ 了 bot 且是直接请求)。返回 task id。 */
export function createTask(input: {
  ownerUid: number;
  chatId: number;
  goal: string;
  kind?: TaskKind;
  maxRounds?: number;
}): number {
  const ts = nowSec();
  const kind = input.kind ?? 'research';
  const maxRounds = input.maxRounds ?? 6;
  const r = getDb()
    .prepare(
      `INSERT INTO tasks (owner_uid, chat_id, goal, kind, state, ledger, progress, search_round, max_rounds, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', '[]', '[]', 0, ?, ?, ?)`,
    )
    .run(input.ownerUid, input.chatId, input.goal, kind, maxRounds, ts, ts);
  return Number(r.lastInsertRowid);
}

export function getTask(id: number): TaskRow | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

/** 某用户的活跃任务(pending/running/blocked/waiting_user)。 */
export function listActiveTasks(ownerUid: number, chatId: number): TaskRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE owner_uid = ? AND chat_id = ? AND state IN ('pending','running','blocked','waiting_user')
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(ownerUid, chatId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** 到点该唤醒的任务(定时)。 */
export function listDueTasks(now = nowSec()): TaskRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE state IN ('pending','blocked','waiting_user') AND next_wake IS NOT NULL AND next_wake <= ?`,
    )
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function setTaskState(id: number, state: TaskState): void {
  getDb()
    .prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?`)
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
    .prepare(`UPDATE tasks SET ledger = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(arr), nowSec(), id);
}

/** 设置进度台账(还差什么/卡在哪)。 */
export function setProgress(id: number, progress: string[]): void {
  getDb()
    .prepare(`UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(progress.slice(0, 20)), nowSec(), id);
}

/** 搜索轮次推进。返回是否达到上限(调用方决定 stop)。 */
export function bumpSearchRound(id: number): { round: number; done: boolean } {
  const t = getTask(id);
  if (!t) return { round: 0, done: true };
  const round = t.search_round + 1;
  const done = round >= t.max_rounds;
  getDb()
    .prepare(`UPDATE tasks SET search_round = ?, updated_at = ? WHERE id = ?`)
    .run(round, nowSec(), id);
  return { round, done };
}

/** 完成: 写结果 + 状态 done + 清唤醒。 */
export function completeTask(id: number, result: string): void {
  getDb()
    .prepare(`UPDATE tasks SET result = ?, state = 'done', next_wake = NULL, wake_trigger = NULL, updated_at = ? WHERE id = ?`)
    .run(result, nowSec(), id);
}

/** 计划下一次唤醒(定时)。 */
export function scheduleWake(id: number, nextWakeTs: number, trigger?: string): void {
  getDb()
    .prepare(`UPDATE tasks SET next_wake = ?, wake_trigger = ?, updated_at = ? WHERE id = ?`)
    .run(nextWakeTs, trigger ?? null, nowSec(), id);
}

/** 清理: 取消任务。 */
export function cancelTask(id: number): void {
  getDb()
    .prepare(`UPDATE tasks SET state = 'cancelled', next_wake = NULL, updated_at = ? WHERE id = ?`)
    .run(nowSec(), id);
}

/** 是否有活跃任务(judge L0 用)。 */
export function hasActiveTask(ownerUid: number, chatId: number): boolean {
  return listActiveTasks(ownerUid, chatId).length > 0;
}

/** env 门控。 */
export function tasksEnabled(): boolean {
  return env().TASK_EXECUTOR_ENABLED;
}
