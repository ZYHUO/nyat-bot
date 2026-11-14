// ────────────────────────────────────────
// Tick 心跳调度器 — 取代 node-cron 的统一任务驱动
//
// 设计:一个 30s 哑心跳(setInterval,无时区/无 cron 解析),每跳扫任务
// 注册表,到期的派发。所有原 cron 任务迁到注册表,unified-tick 只是
// 注册表里的普通一员(每 5min 的 LLM 决策任务),不再有独立调度层。
//
// 触发模式:
//   everySec(n)   — 固定间隔(分钟级以上;秒级心跳粒度内误差 ≤30s)
//   dailyAt(h,m)  — 每天北京时间 h:m(错过窗口补跑一次,重启不漏)
//   weeklyAt(d,h,m) — 每周北京时间周 d h:m
//
// lastRun 持久化 Redis(xxb:tick:lastrun:<name>),重启后:
//   - 间隔任务:从上次真实运行时间续算,不重跑不漏跑
//   - 定点任务:当天/当周窗口已过且未跑 → 立即补跑一次
//
// 防重叠沿用 safeRun(同名任务在跑就跳过,锁握到真正 settle)。
// ────────────────────────────────────────

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../db/redis.js';
import { runWithAiWorkload } from '../ai/workload.js';
import { claimScheduledRun, finishScheduledRun, getScheduledCompletion, getScheduledRun, renewScheduledRun, startScheduledRun } from './scheduled-runs.js';
import type { ScheduledClaim } from './scheduled-runs.js';

export type TickTaskOutcome = { status: 'completed' | 'skipped'; reason?: string };

export type TickTask = {
  name: string;
  /** 固定间隔(秒)。与 dailyAt/weeklyAt 三选一。 */
  everySec?: number;
  /** 每天北京时间几点。 */
  dailyAt?: { hour: number; minute: number };
  /** 每周北京时间(0=周日..6=周六)。 */
  weeklyAt?: { day: number; hour: number; minute: number };
  /** 任务体。 */
  run: () => Promise<void | TickTaskOutcome>;
  /** Only audited idempotent tasks may replay after a failed/lost attempt. */
  retrySafe?: boolean;
};

const HEARTBEAT_MS = 30_000;
const LASTRUN_KEY = (name: string) => `xxb:tick:lastrun:${name}`;

const registry: TickTask[] = [];
let _heartbeat: NodeJS.Timeout | undefined;
let _initialScan: NodeJS.Timeout | undefined;
let _scanning = false;

/** Return the UTC epoch seconds for a Beijing wall-clock time on today's date. */
function bjTodayAt(hour: number, minute: number, nowSec: number): number {
  const dayStart = Math.floor((nowSec + 8 * 3600) / 86400) * 86400 - 8 * 3600;
  return dayStart + hour * 3600 + minute * 60;
}

/** Shared by dispatch and monitoring; overdue daily jobs retain their due time. */
export function nextTickDueAt(task: TickTask, nowSec: number, lastRunSec: number, activationEpochSec = 0): number | null {
  if (task.everySec !== undefined) {
    if (lastRunSec > 0) return lastRunSec + task.everySec;
    if (activationEpochSec > 0) {
      // First activation spreads background work without inventing last-run evidence.
      const hash = [...task.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
      return activationEpochSec + Math.min(task.everySec, 30 + hash % 900);
    }
    return nowSec;
  }
  if (task.dailyAt) {
    const due = bjTodayAt(task.dailyAt.hour, task.dailyAt.minute, nowSec);
    return Math.max(lastRunSec, activationEpochSec) < due ? due : due + 86400;
  }
  if (task.weeklyAt) {
    const day = new Date((nowSec + 8 * 3600) * 1000).getUTCDay();
    const due = bjTodayAt(task.weeklyAt.hour, task.weeklyAt.minute, nowSec);
    // With no registration/completion epoch, do not invent pre-existence work.
    if (lastRunSec === 0 && activationEpochSec === 0) return due + ((task.weeklyAt.day - day + 7) % 7) * 86400;
    let latest = due - ((day - task.weeklyAt.day + 7) % 7) * 86400;
    if (latest > nowSec) latest -= 7 * 86400;
    return Math.max(lastRunSec, activationEpochSec) < latest ? latest : latest + 7 * 86400;
  }
  return null;
}

async function getLastRun(name: string): Promise<number> {
  if (env().DURABLE_CRON_ENABLED) return getScheduledCompletion(name) / 1000;
  try {
    const v = await getRedis().get(LASTRUN_KEY(name));
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

async function setLastRun(name: string, ts: number): Promise<void> {
  try {
    // TTL 40 天:间隔任务最长 6h,定点任务最长 7 天,40 天足够覆盖且能自清洁
    await getRedis().set(LASTRUN_KEY(name), String(ts), 'EX', 40 * 86400);
  } catch {
    /* non-critical */
  }
}

/** 判断任务是否到期。返回 true = 该跑了。 */
async function isDue(task: TickTask, nowSec: number): Promise<boolean> {
  const next = nextTickDueAt(task, nowSec, await getLastRun(task.name), env().PROACTIVE_ACTIVATED_AT_SEC ?? 0);
  return next !== null && next <= nowSec;
}

async function scan(): Promise<void> {
  if (_scanning) return;
  _scanning = true;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const task of registry) {
      try {
        if (env().DURABLE_CRON_ENABLED) {
          if (_running.has(task.name)) continue;
          const due = nextTickDueAt(task, nowSec, await getLastRun(task.name), env().PROACTIVE_ACTIVATED_AT_SEC ?? 0);
          const claim = claimScheduledRun(task.name, due === null ? null : due * 1000, task.retrySafe === true);
          if (claim) {
            // Dispatch telemetry must not hold a SQLite claim behind Redis's
            // offline queue; Redis is not this run's completion authority.
            try { if (getRedis().status === 'ready') void setLastRun(task.name, nowSec); }
            catch { /* telemetry cannot prevent a durable claim from starting */ }
            void safeRunTick(task.name, task.run, claim).catch((err: unknown) => logger.error({ err, name: task.name }, 'Scheduled task start failed'));
          }
          continue;
        }
        if (_running.has(task.name) || !(await isDue(task, nowSec))) continue;
        // 先记 lastRun 再跑:防止任务跑很久期间心跳重入导致双发
        await setLastRun(task.name, nowSec);
        void safeRunTick(task.name, task.run);
      } catch (err) {
        logger.warn({ err, name: task.name }, 'tick: due-check failed');
      }
    }
  } finally {
    _scanning = false;
  }
}

// ── safeRun:沿用原 scheduler 的语义(锁握到真正 settle,超时不放锁) ──

const CRON_TIMEOUT_MS: Record<string, number> = {
  'model-check': 60_000,
  'daily-report': 5 * 60_000,
  'cleanup': 5 * 60_000,
  'knowledge-sync': 15 * 60_000,
  'user-profile-sync': 10 * 60_000,
  'sleep-cycle': 60_000,
  'channel-sync': 10 * 60_000,
  // 命令学习可路由到 mundo(深推理,单次可达 480s);放宽到 12min 免慢调用撞死 tick。
  'bot-command-learn': 12 * 60_000,
};
const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;

const _running = new Set<string>();
const activeTasks = new Set<Promise<void>>();

export interface TickRuntimeSnapshot {
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  durationMs: number | null;
  result: 'completed' | 'skipped' | 'failed' | null;
  reason: string | null;
  timedOut: boolean;
}

const snapshots = new Map<string, TickRuntimeSnapshot>();
const STATUS_KEY = (name: string) => `xxb:tick:status:${name}`;
const SAFE_REASONS = new Set(['disabled', 'no_evidence', 'cooldown', 'model_skip', 'empty_output', 'unparsed', 'llm_failed', 'not_due']);

function saveSnapshot(name: string, value: TickRuntimeSnapshot): void {
  snapshots.set(name, value);
  try {
    const redis = getRedis();
    if (redis.status === 'ready') void redis.set(STATUS_KEY(name), JSON.stringify(value), 'EX', 40 * 86400).catch(() => {});
  }
  catch { /* Runtime metadata is best effort; a telemetry failure must not suppress the job. */ }
}

/** Explicit field projection: persisted metadata and errors never escape verbatim. */
function decodeSnapshot(raw: string | null): TickRuntimeSnapshot | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const num = (k: string) => typeof d[k] === 'number' && Number.isFinite(d[k]) && Number(d[k]) >= 0 ? Number(d[k]) : null;
    return {
      lastStartedAt: num('lastStartedAt'), lastFinishedAt: num('lastFinishedAt'), durationMs: num('durationMs'),
      result: d.result === 'completed' || d.result === 'skipped' || d.result === 'failed' ? d.result : null,
      reason: typeof d.reason === 'string' && SAFE_REASONS.has(d.reason) ? d.reason : null,
      timedOut: d.timedOut === true,
    };
  } catch { return null; }
}

async function safeRunTick(name: string, fn: TickTask['run'], claim?: ScheduledClaim): Promise<void> {
  if (_running.has(name)) return;
  if (claim && !startScheduledRun(claim)) return;
  _running.add(name);
  const renewal = claim ? setInterval(() => {
    try {
      if (!renewScheduledRun(claim)) logger.error({ name }, 'Scheduled task lease lost; result cannot advance completion');
    } catch { logger.error({ name }, 'Scheduled task lease renewal failed'); }
  }, 20_000) : undefined;
  renewal?.unref();
  const start = performance.now();
  let current: TickRuntimeSnapshot = { lastStartedAt: Date.now(), lastFinishedAt: null, durationMs: null, result: null, reason: null, timedOut: false };
  saveSnapshot(name, current);
  const timeoutMs = CRON_TIMEOUT_MS[name] ?? DEFAULT_CRON_TIMEOUT_MS;
  const task: Promise<void> = Promise.resolve().then(() => runWithAiWorkload('background', fn)).then(
    (outcome) => {
      current = { ...current, lastFinishedAt: Date.now(), durationMs: Math.round(performance.now() - start),
        result: outcome?.status === 'skipped' ? 'skipped' : 'completed',
        reason: outcome?.reason && SAFE_REASONS.has(outcome.reason) ? outcome.reason : null };
      saveSnapshot(name, current);
      if (claim) {
        const transientSkip = outcome?.status === 'skipped' && ['llm_failed', 'empty_output', 'unparsed'].includes(outcome.reason ?? '');
        finishScheduledRun(claim, transientSkip ? 'failed' : outcome?.status === 'skipped' ? 'skipped' : 'succeeded');
      }
      logger.debug({ name, durationMs: current.durationMs }, 'Tick task completed');
    },
    (err: unknown) => {
      current = { ...current, lastFinishedAt: Date.now(), durationMs: Math.round(performance.now() - start), result: 'failed' };
      saveSnapshot(name, current);
      if (claim) finishScheduledRun(claim, 'failed');
      logger.error({ err, name, durationMs: current.durationMs }, 'Tick task failed');
    },
  ).catch((err: unknown) => {
    // A settlement storage failure leaves the durable run recoverable/unknown.
    logger.error({ err, name }, 'Scheduled task settlement failed');
  }).finally(() => { if (renewal) clearInterval(renewal); _running.delete(name); activeTasks.delete(task); });
  activeTasks.add(task);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([task, new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        current = { ...current, timedOut: true };
        saveSnapshot(name, current);
        logger.warn({ name, timeoutMs }, 'Tick task exceeded timeout; overlap lock retained');
        resolve();
      }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface TickTaskObservation extends TickRuntimeSnapshot {
  name: string;
  registered: true;
  running: boolean;
  schedule: { everySec?: number; dailyAt?: { hour: number; minute: number }; weeklyAt?: { day: number; hour: number; minute: number } };
  lastDispatchedAt: number | null;
  nextRunAt: number | null;
  due: boolean;
  historyAvailable: boolean;
  durableState?: string;
  lastCompletedAt?: number | null;
}

export async function getTickObservations(nowMs = Date.now()): Promise<TickTaskObservation[]> {
  const tasks = [...registry];
  if (!tasks.length) return [];
  let rows: (string | null)[] = [];
  let historyAvailable = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const redis = getRedis();
    if (redis.status === 'ready') {
      rows = await Promise.race([
        redis.mget(...tasks.flatMap((task) => [LASTRUN_KEY(task.name), STATUS_KEY(task.name)])),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('history unavailable')), 1000); }),
      ]);
      historyAvailable = true;
    }
  } catch { /* Show unknown history rather than block the monitor on Redis retries. */ }
  finally { if (timer) clearTimeout(timer); }
  return tasks.map((task, index) => {
    const rawLast = rows[index * 2];
    const last = rawLast && Number.isFinite(Number(rawLast)) ? Math.max(0, Number(rawLast)) : 0;
    const saved = decodeSnapshot(rows[index * 2 + 1] ?? null);
    const state = snapshots.get(task.name) ?? saved ?? { lastStartedAt: null, lastFinishedAt: null, durationMs: null, result: null, reason: null, timedOut: false };
    const durable = env().DURABLE_CRON_ENABLED ? getScheduledRun(task.name) : null;
    const completedAt = env().DURABLE_CRON_ENABLED ? getScheduledCompletion(task.name) : null;
    const knownHistory = env().DURABLE_CRON_ENABLED || historyAvailable;
    let dueAt = knownHistory ? nextTickDueAt(task, Math.floor(nowMs / 1000), completedAt === null ? last : completedAt / 1000, env().PROACTIVE_ACTIVATED_AT_SEC ?? 0) : null;
    if (durable?.state === 'failed' || durable?.state === 'scheduled') dueAt = durable.available_at / 1000;
    if (durable && ['claimed', 'started', 'unknown'].includes(durable.state)) dueAt = null;
    return { ...state, name: task.name, registered: true, running: _running.has(task.name),
      schedule: { everySec: task.everySec, dailyAt: task.dailyAt, weeklyAt: task.weeklyAt },
      lastDispatchedAt: last > 0 ? last * 1000 : null,
      nextRunAt: _heartbeat && dueAt !== null ? dueAt * 1000 : null,
      due: !!_heartbeat && dueAt !== null && dueAt * 1000 <= nowMs,
      historyAvailable: knownHistory,
      ...(env().DURABLE_CRON_ENABLED ? { durableState: durable?.state ?? 'not_scheduled', lastCompletedAt: completedAt || null } : {}),
    };
  });
}

// ── 对外 API ────────────────────────────────────────────────────────────────

/** 注册任务(启动时一次性注册完)。 */
export function registerTickTask(task: TickTask): void {
  if (registry.some((t) => t.name === task.name)) {
    logger.warn({ name: task.name }, 'tick task duplicate registration, ignored');
    return;
  }
  registry.push(task);
}

/** 启动心跳。 */
export function startHeartbeat(): void {
  if (_heartbeat) return;
  // 首扫延迟 5s:等服务初始化(Redis/bot)就绪
  _initialScan = setTimeout(() => { _initialScan = undefined; void scan(); }, 5_000);
  _heartbeat = setInterval(() => { void scan(); }, HEARTBEAT_MS);
  logger.info({ heartbeatMs: HEARTBEAT_MS, tasks: registry.length }, 'Tick heartbeat started');
}

/** 停止心跳(测试/关停用)。 */
export function stopHeartbeat(): void {
  if (_initialScan) { clearTimeout(_initialScan); _initialScan = undefined; }
  if (_heartbeat) {
    clearInterval(_heartbeat);
    _heartbeat = undefined;
  }
  registry.length = 0;
  // A live async task keeps its overlap lock until it actually settles.
  snapshots.clear();
  logger.info('Tick heartbeat stopped');
}

/** Stop dispatch, then join real task bodies (not their timeout notifications). */
export async function drainHeartbeat(): Promise<void> {
  stopHeartbeat();
  await Promise.allSettled([...activeTasks]);
}

/** 测试/诊断:当前注册表。 */
export function getTickRegistry(): readonly TickTask[] {
  return registry;
}

/** 测试/诊断:手动触发一次扫描。 */
export async function scanOnceForTest(): Promise<void> {
  await scan();
}

/** 兼容层:旧代码查「cron 是否已启动」。 */
export function isStarted(): boolean {
  return _heartbeat !== undefined;
}

/** env 便捷读取(注册表构建用)。 */
export function tickEnv() {
  return env();
}
