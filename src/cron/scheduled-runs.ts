import { randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';

export interface ScheduledClaim {
  taskName: string;
  scheduledAt: number;
  owner: string;
  attempts: number;
}
export interface ScheduledRunRow {
  task_name: string;
  scheduled_at: number;
  state: 'scheduled' | 'claimed' | 'started' | 'succeeded' | 'skipped' | 'failed' | 'unknown';
  attempts: number;
  available_at: number;
  lease_until: number | null;
  retry_safe: number;
  reason: string | null;
}
const LEASE_MS = 90_000;
const MAX_ATTEMPTS = 5;

export function getScheduledCompletion(taskName: string): number {
  const row = getDb().prepare('SELECT last_completed_at FROM scheduled_task_progress WHERE task_name=?').get(taskName) as { last_completed_at: number } | undefined;
  return row?.last_completed_at ?? 0;
}

/** Real completion time, distinct from the calendar occurrence cursor above. */
export function getScheduledFinishedAt(taskName: string): number {
  const row = getDb().prepare(`SELECT MAX(finished_at) AS finished_at FROM scheduled_runs
    WHERE task_name=? AND state IN ('succeeded','skipped')`).get(taskName) as { finished_at: number | null };
  return row.finished_at ?? 0;
}

export function getScheduledRun(taskName: string): ScheduledRunRow | null {
  return getDb().prepare('SELECT * FROM scheduled_runs WHERE task_name=? ORDER BY scheduled_at DESC LIMIT 1').get(taskName) as ScheduledRunRow | undefined ?? null;
}

/** SQLite is the single authority. A copied database is not a cluster lease. */
export function claimScheduledRun(taskName: string, dueAt: number | null, retrySafe: boolean, now = Date.now(), intervalMs?: number): ScheduledClaim | null {
  if (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)) throw new Error('invalid_scheduled_interval');
  const db = getDb();
  return db.transaction(() => {
    db.prepare(`UPDATE scheduled_runs SET state='scheduled',owner=NULL,lease_until=NULL
      WHERE task_name=? AND state='claimed' AND lease_until<=?`).run(taskName, now);
    db.prepare(`UPDATE scheduled_runs SET state=CASE WHEN retry_safe=1 AND attempts<? THEN 'failed' ELSE 'unknown' END,
      reason='owner_lost',owner=NULL,lease_until=NULL,available_at=?
      WHERE task_name=? AND state='started' AND lease_until<=?`).run(MAX_ATTEMPTS, now + 30_000, taskName, now);
    // An uncertain external effect blocks later occurrences until reconciled.
    if (db.prepare(`SELECT 1 FROM scheduled_runs WHERE task_name=? AND state IN ('claimed','started','unknown') LIMIT 1`).get(taskName)) return null;
    let row = db.prepare(`SELECT * FROM scheduled_runs WHERE task_name=? AND state IN ('scheduled','failed') ORDER BY scheduled_at LIMIT 1`).get(taskName) as ScheduledRunRow | undefined;
    if (!row && dueAt !== null && dueAt <= now) {
      if (intervalMs !== undefined) {
        // Check inside the claim transaction: another owner may have finished
        // since this caller read its due time. Retries above keep their identity.
        const finished = getScheduledFinishedAt(taskName);
        if (finished > 0 && now < finished + intervalMs) return null;
        // Missed intervals become one current run, never fabricated successful
        // historical slots or a burst of catch-up calls after enabling/restarting.
        dueAt = now;
      }
      db.prepare(`INSERT OR IGNORE INTO scheduled_runs(task_name,scheduled_at,state,retry_safe,available_at)
        VALUES (?,?,'scheduled',?,?)`).run(taskName, dueAt, retrySafe ? 1 : 0, now);
      row = db.prepare('SELECT * FROM scheduled_runs WHERE task_name=? AND scheduled_at=?').get(taskName, dueAt) as ScheduledRunRow | undefined;
    }
    if (!row || !['scheduled','failed'].includes(row.state) || row.available_at > now || row.attempts >= MAX_ATTEMPTS) return null;
    const owner = randomUUID();
    const changed = db.prepare(`UPDATE scheduled_runs SET state='claimed',owner=?,lease_until=?,reason=NULL
      WHERE task_name=? AND scheduled_at=? AND state IN ('scheduled','failed')`).run(owner, now + LEASE_MS, taskName, row.scheduled_at);
    return changed.changes ? { taskName, scheduledAt: row.scheduled_at, owner, attempts: row.attempts + 1 } : null;
  }).immediate();
}

export function startScheduledRun(claim: ScheduledClaim, now = Date.now()): boolean {
  return getDb().prepare(`UPDATE scheduled_runs SET state='started',started_at=?,attempts=attempts+1
    WHERE task_name=? AND scheduled_at=? AND owner=? AND state='claimed' AND lease_until>?`)
    .run(now, claim.taskName, claim.scheduledAt, claim.owner, now).changes === 1;
}

export function renewScheduledRun(claim: ScheduledClaim, now = Date.now()): boolean {
  return getDb().prepare(`UPDATE scheduled_runs SET lease_until=?
    WHERE task_name=? AND scheduled_at=? AND owner=? AND state='started' AND lease_until>?`)
    .run(now + LEASE_MS, claim.taskName, claim.scheduledAt, claim.owner, now).changes === 1;
}

/** Completion and progress move together; timeout/dispatch is never success. */
export function finishScheduledRun(claim: ScheduledClaim, result: 'succeeded' | 'skipped' | 'failed', now = Date.now()): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM scheduled_runs WHERE task_name=? AND scheduled_at=? AND owner=? AND state='started' AND lease_until>?`)
      .get(claim.taskName, claim.scheduledAt, claim.owner, now) as ScheduledRunRow | undefined;
    if (!row) return false;
    const state = result === 'failed' && (!row.retry_safe || row.attempts >= MAX_ATTEMPTS) ? 'unknown' : result;
    db.prepare(`UPDATE scheduled_runs SET state=?,finished_at=?,owner=NULL,lease_until=NULL,available_at=?,reason=?
      WHERE task_name=? AND scheduled_at=?`).run(state, now, now + Math.min(900_000, 30_000 * 2 ** (row.attempts - 1)),
        result === 'failed' ? (state === 'unknown' ? 'needs_review' : 'retry_pending') : null, claim.taskName, claim.scheduledAt);
    if (result !== 'failed') db.prepare(`INSERT INTO scheduled_task_progress(task_name,last_completed_at) VALUES (?,?)
      ON CONFLICT(task_name) DO UPDATE SET last_completed_at=MAX(last_completed_at,excluded.last_completed_at)`)
      .run(claim.taskName, claim.scheduledAt);
    return true;
  }).immediate();
}
