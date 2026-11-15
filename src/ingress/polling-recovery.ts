import type { Bot, PollingOptions } from 'grammy';
import { GrammyError } from 'grammy';
import { logger } from '../shared/logger.js';
import { ownBotPolling } from './polling-lifecycle.js';
export { cancelBotPollingRetries, drainBotPolling } from './polling-lifecycle.js';

const log = logger.child({ mod: 'polling-recovery' });

/** 第一次重试等这么久，之后翻倍，到 MAX 为止。409 多半是别处一次性 getUpdates 撞了我们，几秒就散。 */
const BACKOFF_BASE_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;

export type PollingDeathKind = 'conflict' | 'unauthorized' | 'other';

export function classifyPollingError(err: unknown): PollingDeathKind {
  if (err instanceof GrammyError) {
    if (err.error_code === 409) return 'conflict';
    if (err.error_code === 401) return 'unauthorized';
  }
  return 'other';
}

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export interface StartPollingDeps {
  start: (opts: PollingOptions) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  exit?: (code: number) => void;
  signal?: AbortSignal;
}

/**
 * 让长轮询死掉时**响亮地**死、并自己爬起来。
 *
 * grammY 的 `bot.start()` 在 getUpdates 收到 401/409 时会 rethrow，promise 就此 reject，
 * 轮询循环停止。原来 index.ts 写的是 `void bot.start(...)`——reject 只会冒到
 * `unhandledRejection`，被记成一句 "non-fatal"，进程活着、轮询死了、心跳不再更新。
 * 5 分钟后 failover 看门狗才判定 "stalled" 并 exit(0)，systemd 再拉起来。
 *
 * 2026-09-28 22:54 → 09-30 10:37：另一个进程每 ~12 分钟用同一 token 调一次 getUpdates，
 * 于是每个周期都是 6.5 分钟活 + 5 分钟装死 + 重启，171 次；进程内状态（去重、节奏、
 * turnContext、self-wake）每 12 分钟归零。
 *
 * 这里：409 / 网络错 → 退避后原地重开轮询（不重启进程，状态保住）；401 → token 坏了，
 * 重试无意义，exit(1) 让 systemd 的日志留下明确原因。
 */
export async function startPollingWithRecovery(
  opts: PollingOptions,
  deps: StartPollingDeps,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); deps.signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    deps.signal?.addEventListener('abort', done, { once: true });
    if (deps.signal?.aborted) done();
  }));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const userOnStart = opts.onStart;
  let attempt = 0;
  for (;;) {
    if (deps.signal?.aborted) return;
    const isRetry = attempt > 0;
    try {
      await deps.start({
        ...opts,
        onStart: (me) => {
          if (isRetry) log.warn({ attempt }, 'Polling resumed after loop death');
          attempt = 0;
          userOnStart?.(me);
        },
      });
      return; // stop() 被正常调用，轮询干净退出
    } catch (err) {
      if (deps.signal?.aborted) return;
      const kind = classifyPollingError(err);
      attempt += 1;
      if (kind === 'unauthorized') {
        log.error({ err }, 'Polling died: bot token rejected (401) — not retrying');
        exit(1);
        return;
      }
      const delay = backoffMs(attempt);
      log.error({ err, kind, attempt, retryInMs: delay }, 'Polling loop died — restarting long poll');
      await sleep(delay);
    }
  }
}

/** 给 index.ts 用的薄封装：把真 bot 接进去。 */
export function startBotPollingWithRecovery(bot: Bot, opts: PollingOptions): void {
  const runningPolling = ownBotPolling(signal => startPollingWithRecovery(opts, { start: (o) => bot.start(o), signal }));
  // Keep the original promise for shutdown: a handler still running after
  // bot.stop() must settle before the database can be declared quiescent.
  void runningPolling.catch(() => log.error('Polling recovery unexpectedly terminated'));
}
