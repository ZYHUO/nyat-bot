import type { Redis } from 'ioredis';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { getSandboxCapability } from '../sandbox/terminal.js';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  checks: {
    redis: { ok: boolean; latency_ms: number };
    sqlite: { ok: boolean };
    sandbox: { ok: boolean; isolation_required: boolean; bwrap_available: boolean; reason?: string };
    cognitive: {
      ok: boolean;
      event_log_available: boolean;
      outbox_available: boolean;
      outbox_pending: number;
      outbox_failed: number;
      agency_available: boolean;
      agency_nonterminal: number;
    };
    timestamp: number;
  };
}

function readCount(db: ReturnType<typeof getDb>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count?: unknown } | undefined;
    return typeof row?.count === 'number' && Number.isFinite(row.count) ? Math.max(0, Math.trunc(row.count)) : 0;
  } catch {
    return 0;
  }
}

function readCognitiveHealth(): HealthStatus['checks']['cognitive'] {
  const fallback: HealthStatus['checks']['cognitive'] = {
    ok: false,
    event_log_available: false,
    outbox_available: false,
    outbox_pending: 0,
    outbox_failed: 0,
    agency_available: false,
    agency_nonterminal: 0,
  };
  try {
    const db = getDb();
    const tableExists = (name: string): boolean => {
      try {
        return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      } catch {
        return false;
      }
    };
    const eventLogAvailable = tableExists('cognitive_events');
    const outboxAvailable = tableExists('cognitive_outbox');
    const agencyAvailable = tableExists('agency_runs');
    const outboxPending = outboxAvailable
      ? readCount(db, "SELECT COUNT(*) AS count FROM cognitive_outbox WHERE status IN ('pending','processing')")
      : 0;
    const outboxFailed = outboxAvailable
      ? readCount(db, "SELECT COUNT(*) AS count FROM cognitive_outbox WHERE status = 'failed'")
      : 0;
    const agencyNonterminal = agencyAvailable
      ? readCount(db, "SELECT COUNT(*) AS count FROM agency_runs WHERE status IN ('pending','running','waiting')")
      : 0;
    return {
      ok: eventLogAvailable && outboxAvailable && agencyAvailable,
      event_log_available: eventLogAvailable,
      outbox_available: outboxAvailable,
      outbox_pending: outboxPending,
      outbox_failed: outboxFailed,
      agency_available: agencyAvailable,
      agency_nonterminal: agencyNonterminal,
    };
  } catch {
    return fallback;
  }
}

export async function checkHealth(redis: Redis): Promise<HealthStatus> {
  const checks = {
    redis: { ok: false, latency_ms: 0 },
    sqlite: { ok: false },
    sandbox: { ok: false, isolation_required: true, bwrap_available: false },
    cognitive: readCognitiveHealth(),
    timestamp: Date.now(),
  };

  // Redis check
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    logger.warn({ err }, 'Health: Redis check failed');
  }

  // SQLite check
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    checks.sqlite = { ok: true };
  } catch (err) {
    logger.warn({ err }, 'Health: SQLite check failed');
  }

  try {
    const capability = getSandboxCapability();
    const ok = !capability.terminalEnabled || !capability.isolationRequired || capability.bwrapAvailable;
    checks.sandbox = {
      ok,
      isolation_required: capability.isolationRequired,
      bwrap_available: capability.bwrapAvailable,
      ...(capability.reason ? { reason: capability.reason } : {}),
    };
    if (!ok) logger.warn({ capability }, 'Health: sandbox isolation unavailable');
  } catch (err) {
    logger.warn({ err }, 'Health: sandbox capability check failed');
  }

  const allOk = checks.redis.ok && checks.sqlite.ok && checks.sandbox.ok && checks.cognitive.ok;
  const anyOk = checks.redis.ok || checks.sqlite.ok || checks.sandbox.ok || checks.cognitive.ok;

  return {
    status: allOk ? 'ok' : anyOk ? 'degraded' : 'error',
    uptime: process.uptime(),
    checks,
  };
}
