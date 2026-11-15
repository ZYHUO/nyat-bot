import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Belief verification closes a three-part gap: world-facts emitted `world_change`
// events, the projector turned them into `stale_belief` debts, and `contradict()`
// could mark a belief contradicted — but nothing read the debts, so beliefs the
// world had invalidated stayed in the prompt forever. Measured 2026-09-19:
// 20 stale_belief debts open, 207 beliefs all active.

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const envValues: Record<string, unknown> = { BELIEF_VERIFY_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(`CREATE TABLE IF NOT EXISTS cognitive_debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, owner_uid INTEGER, task_id TEXT,
    kind TEXT, statement TEXT, source_event_ids TEXT, priority INTEGER, confidence REAL,
    status TEXT, resolution TEXT, superseded_by INTEGER, created_at INTEGER, updated_at INTEGER,
    next_check_at INTEGER, expires_at INTEGER, scope_key TEXT, visibility TEXT,
    dedupe_key TEXT, resolution_event_id TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS core_beliefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_table TEXT, source_row_id INTEGER,
    predicate TEXT, summary TEXT, evidence TEXT, confidence REAL, status TEXT,
    ttl_sec INTEGER, scope_key TEXT, refute_count INTEGER DEFAULT 0,
    last_confirmed_at INTEGER, updated_at INTEGER, created_at INTEGER)`);
  envValues['BELIEF_VERIFY_ENABLED'] = true;
});

const load = async () => {
  vi.resetModules();
  return await import('../../../src/agent/belief-verify.js');
};

function seedEvent(id: string, entity: string, props: Record<string, string>): void {
  db.prepare(
    `INSERT INTO cognitive_events (id, type, source, visibility, scope_key, chat_id, occurred_at, correlation_id, sequence, fact_json, created_at)
     VALUES (?, 'world_change', 'host', 'chat', 'chat:-100', -100, 1, 'c', 1, ?, 1)`,
  ).run(id, JSON.stringify({ entityName: entity, properties: props }));
}

function seedDebt(eventId: string, subjectKey: string): number {
  const r = db.prepare(
    `INSERT INTO cognitive_debts (kind, statement, source_event_ids, priority, confidence, status, created_at, updated_at, scope_key)
     VALUES ('stale_belief', '世界变了', ?, 5, 0.75, 'open', 1, 1, ?)`,
  ).run(JSON.stringify([eventId]), subjectKey);
  return Number(r.lastInsertRowid);
}

function seedBelief(summary: string, scopeKey: string): number {
  const r = db.prepare(
    `INSERT INTO core_beliefs (source_table, source_row_id, predicate, summary, evidence, confidence, status, scope_key, refute_count, updated_at, created_at)
     VALUES ('t', 1, 'p', ?, '["e"]', 0.8, 'active', ?, 0, 1, 1)`,
  ).run(summary, scopeKey);
  return Number(r.lastInsertRowid);
}

describe('belief verification', () => {
  it('contradicts a belief that asserts a DIFFERENT value than the world reports', async () => {
    const m = await load();
    // The belief names the entity and asserts a property, but its stated value
    // is not what the event reports — genuinely stale.
    seedEvent('evt-1', 'dorocloud', { title: 'dorocloud' });
    seedDebt('evt-1', 'chat:-100');
    const beliefId = seedBelief('dorocloud 这个群叫「旧名字」', 'chat:-100');

    const r = m.verifyStaleBeliefs();
    expect(r.examined).toBe(1);
    expect(r.contradicted).toBe(1);

    const row = db.prepare('SELECT status, refute_count FROM core_beliefs WHERE id = ?').get(beliefId) as { status: string; refute_count: number };
    expect(row.status).toBe('contradicted');
    expect(row.refute_count).toBeGreaterThan(0);
  });

  it('does NOT treat a confirming world change as a contradiction', async () => {
    const m = await load();
    // Measured on the first live run: a name-overlap check contradicted three
    // beliefs of the form "「某群名」（place）" because the world_change was
    // CONFIRMING that same title. Confirmation is not contradiction.
    seedEvent('evt-confirm', 'dorocloud', { title: 'dorocloud', type: 'supergroup' });
    seedDebt('evt-confirm', 'chat:-100');
    const beliefId = seedBelief('dorocloud（place）', 'chat:-100');

    m.verifyStaleBeliefs();
    const row = db.prepare('SELECT status FROM core_beliefs WHERE id = ?').get(beliefId) as { status: string };
    expect(row.status).toBe('active');
  });

  it('leaves an unrelated belief alone', async () => {
    const m = await load();
    seedEvent('evt-2', 'dorocloud', { title: 'dorocloud' });
    seedDebt('evt-2', 'chat:-100');
    const beliefId = seedBelief('阿伟喜欢折腾显卡', 'chat:-100');

    m.verifyStaleBeliefs();
    const row = db.prepare('SELECT status FROM core_beliefs WHERE id = ?').get(beliefId) as { status: string };
    // A title change must not quietly empty the prompt of unrelated beliefs.
    expect(row.status).toBe('active');
  });

  it('discharges the debt either way so it cannot pile up unread', async () => {
    const m = await load();
    seedEvent('evt-3', 'dorocloud', { title: 'dorocloud' });
    const debtId = seedDebt('evt-3', 'chat:-100');
    seedBelief('阿伟喜欢折腾显卡', 'chat:-100');

    const r = m.verifyStaleBeliefs();
    expect(r.cleared).toBe(1);
    const row = db.prepare('SELECT status, resolution FROM cognitive_debts WHERE id = ?').get(debtId) as { status: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('verified_no_conflict');
  });

  it('leaves a debt open when it has no provenance to check', async () => {
    const m = await load();
    db.prepare(
      `INSERT INTO cognitive_debts (kind, statement, source_event_ids, priority, confidence, status, created_at, updated_at)
       VALUES ('stale_belief', 'x', NULL, 5, 0.5, 'open', 1, 1)`,
    ).run();
    const r = m.verifyStaleBeliefs();
    // "We could not check" must never be recorded as "we checked and it was fine".
    expect(r.cleared).toBe(0);
    expect(r.contradicted).toBe(0);
  });

  it('does nothing when disabled', async () => {
    const m = await load();
    envValues['BELIEF_VERIFY_ENABLED'] = false;
    seedEvent('evt-4', 'dorocloud', { title: 'dorocloud' });
    seedDebt('evt-4', 'chat:-100');
    seedBelief('dorocloud 群', 'chat:-100');
    const r = m.verifyStaleBeliefs();
    expect(r.examined).toBe(0);
  });
});
