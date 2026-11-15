import type { Hono } from 'hono';
import type { StartupOwnership } from './ownership.js';
import { ownsMetaLoop } from './ownership.js';

type CheckState = 'ready' | 'not_ready' | 'not_required';
type WorkerName = 'messages' | 'tasks' | 'codeact';
interface RedisStatus { readonly status: string }

/** Only observe the worker's real connections; never enqueue a synthetic job. */
export interface ReadinessWorker {
  readonly client: Promise<RedisStatus>;
  readonly closing: Promise<void> | undefined;
  waitUntilReady(): Promise<RedisStatus>;
  isRunning(): boolean;
  isPaused(): boolean;
}

interface ReadinessOptions {
  ownership: StartupOwnership;
  cronEnabled: boolean;
  metaEnabled: boolean;
  tasksEnabled: boolean;
  oneBotEnabled: boolean;
  nyatDbEnabled: boolean;
  releaseId: string;
  pid: number;
  processStartedAt: number;
  timeoutMs?: number;
  pollFreshnessMs?: number;
}

interface ReadinessDependencies {
  redis: RedisStatus & { ping(): Promise<string> };
  querySqlite(): void;
  queryNyatDb(): void;
  cronRunning(): boolean;
  metaRunning(): boolean;
  oneBotReady(): boolean;
  now?: () => number;
}

/**
 * Local readiness, not proof of model quality, remote delivery, a distributed
 * writer lease, or successful cron work. Poll evidence belongs to this object
 * and this process; the shared failover heartbeat must never qualify a restart.
 */
export class StartupReadiness {
  private bootComplete = false;
  private draining = false;
  private ingressMode: 'polling' | 'webhook' | undefined;
  private lastPollSuccess: number | undefined;
  private registeredWebhook = false;
  private readonly workers = new Map<WorkerName, () => boolean>();
  private pendingPing: Promise<boolean> | undefined;

  constructor(private readonly options: ReadinessOptions, private readonly deps: ReadinessDependencies) {}

  completeBoot(): void { this.bootComplete = true; }
  beginDrain(): void { this.draining = true; }
  usePolling(): void { this.ingressMode = 'polling'; }
  webhookRegistered(): void { this.ingressMode = 'webhook'; this.registeredWebhook = true; }
  pollSucceeded(): void { this.lastPollSuccess = this.now(); }

  watchWorker(name: WorkerName, worker: ReadinessWorker | undefined): void {
    if (!worker) return;
    let connections: RedisStatus[] | undefined;
    // One pending initialization per worker, not one waiter per HTTP probe.
    void Promise.all([worker.client, worker.waitUntilReady()]).then(
      (clients) => { connections = clients; },
      () => { connections = undefined; },
    );
    this.workers.set(name, () => !!connections
      && connections.every(client => client.status === 'ready')
      && worker.isRunning() && !worker.isPaused() && !worker.closing);
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  private async redisReady(): Promise<boolean> {
    if (this.deps.redis.status !== 'ready') return false;
    if (!this.pendingPing) {
      // Keep a timed-out command until it actually settles: a broken Redis must
      // not accumulate one indefinitely queued command per readiness request.
      const ping = Promise.resolve().then(() => this.deps.redis.ping()).then(value => value === 'PONG', () => false);
      this.pendingPing = ping;
      void ping.finally(() => { if (this.pendingPing === ping) this.pendingPing = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.pendingPing,
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.options.timeoutMs ?? 1_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async check() {
    const { ownership } = this.options;
    const checks: Record<string, CheckState> = {
      lifecycle: this.bootComplete && !this.draining ? 'ready' : 'not_ready',
    };
    if (this.bootComplete && !this.draining) {
      checks.redis = await this.redisReady() ? 'ready' : 'not_ready';
    }
    // A probe awaiting Redis must not reopen SQLite after shutdown closed it.
    if (this.bootComplete && !this.draining) {
      try { this.deps.querySqlite(); checks.sqlite = 'ready'; }
      catch { checks.sqlite = 'not_ready'; }
      checks.nyatdb = 'not_required';
      if (this.options.nyatDbEnabled) {
        try { this.deps.queryNyatDb(); checks.nyatdb = 'ready'; }
        catch { checks.nyatdb = 'not_ready'; }
      }

      const pollAge = this.lastPollSuccess === undefined ? Infinity : this.now() - this.lastPollSuccess;
      checks.telegram = !ownership.botIngress ? 'not_required'
        : (this.ingressMode === 'webhook' ? this.registeredWebhook && ownership.http
          : this.ingressMode === 'polling' && pollAge >= 0 && pollAge <= (this.options.pollFreshnessMs ?? 90_000))
          ? 'ready' : 'not_ready';
      checks.onebot = !this.options.oneBotEnabled ? 'not_required' : this.deps.oneBotReady() ? 'ready' : 'not_ready';
      for (const name of ['messages', 'tasks', 'codeact'] as const) {
        const required = ownership.worker && (name === 'messages'
          || (name === 'tasks' ? this.options.tasksEnabled : this.options.metaEnabled));
        checks[`worker_${name}`] = !required ? 'not_required' : this.workers.get(name)?.() ? 'ready' : 'not_ready';
      }
      checks.cron = !ownership.cron || !this.options.cronEnabled ? 'not_required'
        : this.deps.cronRunning() ? 'ready' : 'not_ready';
      checks.meta = !ownsMetaLoop(ownership) || !this.options.metaEnabled ? 'not_required'
        : this.deps.metaRunning() ? 'ready' : 'not_ready';
    }
    // SIGTERM may arrive while the Redis query is awaiting its response.
    if (this.draining) checks.lifecycle = 'not_ready';
    return {
      status: Object.values(checks).every(value => value !== 'not_ready') ? 'ready' as const : 'not_ready' as const,
      pid: this.options.pid,
      processStartedAt: this.options.processStartedAt,
      releaseId: this.options.releaseId,
      draining: this.draining,
      checks,
    };
  }
}

export function registerReadinessRoute(app: Hono, readiness: StartupReadiness | undefined): void {
  if (!readiness) return;
  app.get('/ready', async (c) => {
    const report = await readiness.check();
    c.header('Cache-Control', 'no-store');
    return c.json(report, report.status === 'ready' ? 200 : 503);
  });
}

/** Finish boot only after shutdown can synchronously withdraw readiness. */
export function registerReadinessLifecycle(
  readiness: StartupReadiness | undefined,
  shutdown: (signal: string) => Promise<void>,
  signals: { on(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown } = process,
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    signals.on(signal, () => {
      readiness?.beginDrain();
      void shutdown(signal);
    });
  }
  readiness?.completeBoot();
}
