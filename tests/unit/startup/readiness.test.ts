import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Bot } from 'grammy';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupReadiness, registerReadinessLifecycle, registerReadinessRoute } from '../../../src/startup/readiness.js';
import { installPollHeartbeat } from '../../../src/ingress/failover.js';

vi.mock('../../../src/shared/logger.js', () => ({ logger: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) } }));

const ownership = { botIngress: false, worker: false, cron: false, http: true };
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  vi.useRealTimers();
});

function fixture(overrides: Partial<ConstructorParameters<typeof StartupReadiness>[0]> = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY)');
  const redis = { status: 'ready', ping: vi.fn(async () => 'PONG'), set: vi.fn(async () => 'OK') };
  const state = { now: 1_000_000, cron: true, meta: true, onebot: true };
  const querySqlite = vi.fn(() => { db.prepare('SELECT name FROM _migrations LIMIT 1').get(); });
  const queryNyatDb = vi.fn(() => {});
  const probe = new StartupReadiness({
    ownership, cronEnabled: false, metaEnabled: false, tasksEnabled: false,
    oneBotEnabled: false, nyatDbEnabled: false, releaseId: 'a'.repeat(40), pid: 123,
    processStartedAt: 999_000, timeoutMs: 20, ...overrides,
  }, {
    redis, querySqlite, queryNyatDb, cronRunning: () => state.cron, metaRunning: () => state.meta,
    oneBotReady: () => state.onebot, now: () => state.now,
  });
  const app = new Hono();
  registerReadinessRoute(app, probe);
  const signals = new EventEmitter();
  const shutdown = vi.fn(async () => {});
  const boot = () => registerReadinessLifecycle(probe, shutdown, signals);
  return { db, redis, state, querySqlite, queryNyatDb, probe, app, signals, shutdown, boot };
}

function workerFixture() {
  const client = { status: 'ready' };
  const blocking = { status: 'ready' };
  const state = { running: true, paused: false };
  const worker = {
    client: Promise.resolve(client),
    closing: undefined as Promise<void> | undefined,
    waitUntilReady: async () => blocking,
    isRunning: () => state.running,
    isPaused: () => state.paused,
  };
  return { worker, client, blocking, state };
}

describe('local release readiness', () => {
  it('is absent without opt-in and never calls dependencies while booting', async () => {
    const disabled = new Hono();
    registerReadinessRoute(disabled, undefined);
    expect((await disabled.request('/ready')).status).toBe(404);
    const f = fixture();
    expect((await f.app.request('/ready')).status).toBe(503);
    expect(f.redis.ping).not.toHaveBeenCalled();
    expect(f.querySqlite).not.toHaveBeenCalled();
  });

  it('returns the current release/process identity with no cache or secret-bearing errors', async () => {
    const f = fixture();
    f.boot();
    const response = await f.app.request('/ready');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ status: 'ready', pid: 123, processStartedAt: 999_000,
      releaseId: 'a'.repeat(40), draining: false, checks: { redis: 'ready', sqlite: 'ready', telegram: 'not_required' } });
    f.redis.ping.mockRejectedValueOnce(new Error('secret://must-not-be-in-http-response'));
    const failed = await f.app.request('/ready');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret://');
    f.db.close();
    expect((await f.probe.check()).checks.sqlite).toBe('not_ready');
  });

  it('rejects a disconnected client and a non-PONG reply', async () => {
    const f = fixture(); f.boot();
    f.redis.status = 'reconnecting';
    expect((await f.probe.check()).status).toBe('not_ready');
    expect(f.redis.ping).not.toHaveBeenCalled();
    f.redis.status = 'ready';
    f.redis.ping.mockResolvedValue('unexpected');
    expect((await f.probe.check()).checks.redis).toBe('not_ready');
  });

  it('requires the configured NyatDB handle and never probes it when disabled or draining', async () => {
    const disabled = fixture(); disabled.boot();
    disabled.queryNyatDb.mockImplementation(() => { throw new Error('not configured'); });
    expect((await disabled.probe.check()).checks.nyatdb).toBe('not_required');
    expect(disabled.queryNyatDb).not.toHaveBeenCalled();
    const enabled = fixture({ nyatDbEnabled: true }); enabled.boot();
    enabled.queryNyatDb.mockImplementationOnce(() => { throw new Error('secret-path-or-open-failure'); });
    const failed = await enabled.app.request('/ready');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret-path');
    expect((await enabled.probe.check()).checks.nyatdb).toBe('ready');
    enabled.queryNyatDb.mockClear();
    enabled.signals.emit('SIGTERM');
    expect((await enabled.probe.check()).status).toBe('not_ready');
    expect(enabled.queryNyatDb).not.toHaveBeenCalled();
  });

  it('bounds a stalled Redis probe without accumulating commands, and recovers after settlement', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.boot();
    let finish!: (value: string) => void;
    f.redis.ping.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.probe.check();
    await vi.advanceTimersByTimeAsync(20);
    expect((await first).checks.redis).toBe('not_ready');
    const again = Promise.all([f.probe.check(), f.probe.check()]);
    await vi.advanceTimersByTimeAsync(20);
    expect((await again).map(result => result.status)).toEqual(['not_ready', 'not_ready']);
    expect(f.redis.ping).toHaveBeenCalledTimes(1);
    finish('PONG');
    await Promise.resolve(); await Promise.resolve();
    expect((await f.probe.check()).status).toBe('ready');
  });

  it.each(['SIGTERM', 'SIGINT'])('withdraws HTTP readiness synchronously at %s before any shutdown await', async (signal) => {
    const f = fixture();
    let finish!: () => void;
    f.shutdown.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.boot();
    expect((await f.app.request('/ready')).status).toBe(200);
    f.signals.emit(signal);
    expect(f.shutdown).toHaveBeenCalledWith(signal);
    expect((await f.app.request('/ready')).status).toBe(503);
    expect((await f.probe.check()).draining).toBe(true);
    finish();
  });

  it('rechecks draining when SIGTERM arrives while Redis is pending', async () => {
    const f = fixture(); f.boot();
    let finish!: (value: string) => void;
    f.redis.ping.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.probe.check();
    await Promise.resolve();
    f.signals.emit('SIGTERM');
    finish('PONG');
    expect((await pending).status).toBe('not_ready');
    expect(f.querySqlite).not.toHaveBeenCalled();
    expect(f.queryNyatDb).not.toHaveBeenCalled();
  });

  it('keeps shutdown handling installed when readiness is disabled', () => {
    const signals = new EventEmitter();
    const shutdown = vi.fn(async () => {});
    registerReadinessLifecycle(undefined, shutdown, signals);
    signals.emit('SIGTERM');
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
  });

  it('requires successful getUpdates in this process, rejects Telegram errors, and expires evidence', async () => {
    const f = fixture({ ownership: { ...ownership, botIngress: true } });
    f.boot(); f.probe.usePolling();
    // Real grammY transformer composition with a terminal synthetic transport.
    const bot = new Bot('123:synthetic');
    let apiOk = false;
    bot.api.config.use(async () => apiOk
      ? { ok: true, result: [] } as never
      : { ok: false, error_code: 409, description: 'synthetic conflict' } as never);
    installPollHeartbeat(bot, f.redis as never, () => f.probe.pollSucceeded());
    // The previous process's shared Redis heartbeat cannot qualify this boot.
    await f.redis.set('xxb:poll:lastok', String(f.state.now));
    expect((await f.probe.check()).checks.telegram).toBe('not_ready');
    await expect(bot.api.getUpdates()).rejects.toThrow('synthetic conflict');
    expect((await f.probe.check()).checks.telegram).toBe('not_ready');
    apiOk = true;
    await bot.api.getUpdates();
    expect((await f.probe.check()).status).toBe('ready');
    f.state.now += 90_001;
    expect((await f.probe.check()).checks.telegram).toBe('not_ready');
    await bot.api.getUpdates();
    expect((await f.probe.check()).status).toBe('ready');
    const nextProcess = fixture({ ownership: { ...ownership, botIngress: true } });
    nextProcess.boot(); nextProcess.probe.usePolling();
    expect((await nextProcess.probe.check()).checks.telegram).toBe('not_ready');
  });

  it('requires a registered webhook and its local HTTP receiver', async () => {
    const f = fixture({ ownership: { ...ownership, botIngress: true } }); f.boot();
    expect((await f.probe.check()).checks.telegram).toBe('not_ready');
    f.probe.webhookRegistered();
    expect((await f.probe.check()).status).toBe('ready');
    const broken = fixture({ ownership: { ...ownership, botIngress: true, http: false } });
    broken.boot(); broken.probe.webhookRegistered();
    expect((await broken.probe.check()).checks.telegram).toBe('not_ready');
  });

  it('observes both actual worker connections and rejects paused, stopped, or closing workers', async () => {
    const f = fixture({ ownership: { ...ownership, worker: true } }); f.boot();
    expect((await f.probe.check()).checks.worker_messages).toBe('not_ready');
    const w = workerFixture();
    f.probe.watchWorker('messages', w.worker);
    expect((await f.probe.check()).status).toBe('ready');
    w.blocking.status = 'reconnecting';
    expect((await f.probe.check()).status).toBe('not_ready');
    w.blocking.status = 'ready'; w.client.status = 'end';
    expect((await f.probe.check()).status).toBe('not_ready');
    w.client.status = 'ready'; w.state.paused = true;
    expect((await f.probe.check()).status).toBe('not_ready');
    w.state.paused = false; w.state.running = false;
    expect((await f.probe.check()).status).toBe('not_ready');
    w.state.running = true; w.worker.closing = new Promise(() => {});
    expect((await f.probe.check()).status).toBe('not_ready');
  });

  it('requires configured task/CodeAct workers, scheduler, Meta timer and OneBot transport', async () => {
    const f = fixture({ ownership: { ...ownership, worker: true, cron: true },
      tasksEnabled: true, metaEnabled: true, cronEnabled: true, oneBotEnabled: true }); f.boot();
    for (const name of ['messages', 'tasks', 'codeact'] as const) f.probe.watchWorker(name, workerFixture().worker);
    expect((await f.probe.check()).status).toBe('ready');
    f.state.cron = false;
    expect((await f.probe.check()).checks.cron).toBe('not_ready');
    f.state.cron = true; f.state.meta = false;
    expect((await f.probe.check()).checks.meta).toBe('not_ready');
    f.state.meta = true; f.state.onebot = false;
    expect((await f.probe.check()).checks.onebot).toBe('not_ready');
    const missing = fixture({ ownership: { ...ownership, worker: true }, tasksEnabled: true, metaEnabled: true });
    missing.boot(); missing.probe.watchWorker('messages', workerFixture().worker);
    expect((await missing.probe.check()).checks).toMatchObject({ worker_tasks: 'not_ready', worker_codeact: 'not_ready' });
  });

  it('does not ascribe another process\'s scheduler or Meta responsibilities to an HTTP role', async () => {
    const f = fixture({ cronEnabled: true, metaEnabled: true, tasksEnabled: true }); f.boot();
    f.state.cron = false; f.state.meta = false;
    expect((await f.probe.check()).status).toBe('ready');
  });

  it('pins the executable composition into the actual startup and shutdown path', () => {
    const source = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('config.READINESS_ENABLED ? new StartupReadiness(');
    expect(source).toContain('registerReadinessRoute(app, readiness)');
    expect(source).toContain('installPollHeartbeat(bot, redis, () => readiness?.pollSucceeded())');
    expect(source).toContain('readiness?.webhookRegistered()');
    expect(source).toContain("readiness?.watchWorker('messages', messageWorker)");
    expect(source).toContain("readiness?.watchWorker('tasks', taskWorker)");
    expect(source).toContain("readiness?.watchWorker('codeact', codeActWorker)");
    expect(source).toContain('registerReadinessLifecycle(readiness, shutdown)');
    expect(source).toContain('nyatDbEnabled: config.NYATDB_ENABLED');
    expect(source).toContain('nyatDbForReadiness = getNyatDb()');
    expect(source).toContain('nyatDbForReadiness.stats()');
    expect(source.indexOf('registerReadinessLifecycle(readiness, shutdown)')).toBeGreaterThan(source.indexOf('startMetaLoop();'));
  });
});
