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

export type TickTask = {
  name: string;
  /** 固定间隔(秒)。与 dailyAt/weeklyAt 三选一。 */
  everySec?: number;
  /** 每天北京时间几点。 */
  dailyAt?: { hour: number; minute: number };
  /** 每周北京时间(0=周日..6=周六)。 */
  weeklyAt?: { day: number; hour: number; minute: number };
  /** 任务体。 */
  run: () => Promise<void>;
};

const HEARTBEAT_MS = 30_000;
const LASTRUN_KEY = (name: string) => `xxb:tick:lastrun:${name}`;

const registry: TickTask[] = [];
let _heartbeat: NodeJS.Timeout | undefined;
let _scanning = false;

/** 北京时间的「当天 h:m」对应的 epoch 秒。 */
function bjTodayAt(hour: number, minute: number): number {
  const now = Date.now();
  // 北京 = UTC+8,无 DST,直接算
  const bjNow = now + 8 * 3600_000;
  const bjMidnight = Math.floor(bjNow / 86400_000) * 86400_000;
  return Math.floor((bjMidnight + (hour * 3600 + minute * 60) * 1000) / 1000);
}

/** 北京时间现在星期几(0=周日)与当天已过秒数。 */
function bjNowParts(): { day: number; secOfDay: number } {
  const bj = Date.now() + 8 * 3600_000;
  const day = new Date(bj).getUTCDay();
  const secOfDay = Math.floor((bj % 86400_000) / 1000);
  return { day, secOfDay };
}

async function getLastRun(name: string): Promise<number> {
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
  const last = await getLastRun(task.name);

  if (task.everySec !== undefined) {
    // 间隔任务:last=0(从未跑过/Redis 丢)→ 立即跑,让新任务尽快生效
    if (last === 0) return true;
    return nowSec - last >= task.everySec;
  }

  if (task.dailyAt) {
    const dueAt = bjTodayAt(task.dailyAt.hour, task.dailyAt.minute);
    // 已过定点时刻,且今天没跑过(last < dueAt)→ 补跑
    return nowSec >= dueAt && last < dueAt;
  }

  if (task.weeklyAt) {
    const { day, secOfDay } = bjNowParts();
    if (day !== task.weeklyAt.day) return false;
    const dueSec = task.weeklyAt.hour * 3600 + task.weeklyAt.minute * 60;
    if (secOfDay < dueSec) return false;
    // 本周窗口已开;last 落在本周窗口开启之前(或从未跑)→ 跑
    // 窗口开启时刻 = 今天定点;last < 那个时刻 = 这周还没跑过
    const dueAt = bjTodayAt(task.weeklyAt.hour, task.weeklyAt.minute);
    return last < dueAt;
  }

  return false;
}

async function scan(): Promise<void> {
  if (_scanning) return;
  _scanning = true;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const task of registry) {
      try {
        if (!(await isDue(task, nowSec))) continue;
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

async function safeRunTick(name: string, fn: () => Promise<void>): Promise<void> {
  if (_running.has(name)) {
    logger.warn({ name }, 'Tick task already running, skipping');
    return;
  }
  _running.add(name);
  const start = performance.now();
  const timeoutMs = CRON_TIMEOUT_MS[name] ?? DEFAULT_CRON_TIMEOUT_MS;
  // 锁只在 fn() 真正 settle 时释放,不在超时时释放:超时只记告警,锁握到
  // fn 结束,下个心跳因锁在被正常跳过(防后台任务并发双发)。
  const task = fn().then(
    () => { logger.debug({ name, durationMs: Math.round(performance.now() - start) }, 'Tick task completed'); },
    (err) => { logger.error({ err, name, durationMs: Math.round(performance.now() - start) }, 'Tick task failed'); },
  ).finally(() => { _running.delete(name); });

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Tick task ${name} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    await Promise.race([task, timeout]);
  } catch {
    logger.warn(
      { name, timeoutMs },
      'Tick task exceeded timeout (仍在后台跑,锁保持到结束,不会并发起同名任务)',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  setTimeout(() => { void scan(); }, 5_000);
  _heartbeat = setInterval(() => { void scan(); }, HEARTBEAT_MS);
  logger.info({ heartbeatMs: HEARTBEAT_MS, tasks: registry.length }, 'Tick heartbeat started');
}

/** 停止心跳(测试/关停用)。 */
export function stopHeartbeat(): void {
  if (_heartbeat) {
    clearInterval(_heartbeat);
    _heartbeat = undefined;
  }
  registry.length = 0;
  _running.clear();
  logger.info('Tick heartbeat stopped');
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
