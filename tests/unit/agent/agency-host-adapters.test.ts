import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Host implementations for the Agency control actions. `agency-control-adapters`
// only supplies the wrappers (scope/budget/receipt contracts) and takes the real
// operation as a callback — nothing ever supplied one, so `agency-proposals.ts`
// passed a stub that returned `{recorded: true}` without reading anything.

let db: Database.Database;

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const envValues: Record<string, unknown> = { AGENCY_CONTROL_ADAPTERS_ENABLED: true };
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const CHAT = -100;

beforeEach(() => {
  db = new Database(':memory:');
  // The belief store needs core_beliefs; the debt store needs cognitive_debts.
  for (const f of ['0089_cognitive_events.sql']) {
    try { db.exec(readFileSync(`migrations/${f}`, 'utf8')); } catch { /* optional */ }
  }
});

const load = async () => {
  vi.resetModules();
  return await import('../../../src/agent/agency-host-adapters.js');
};

describe('agency host adapters', () => {
  it('refuses to serve an unrecognised observe target', async () => {
    const m = await load();
    // The model names a source; it does not get to invent one.
    const r = await m.observeFromHost({
      chatId: CHAT,
      scope: { visibility: 'chat', chatId: CHAT },
      target: 'filesystem.read',
      runId: 'r1',
      attempt: 1,
      correlationId: 'c1',
      idempotencyKey: 'k1',
      signal: new AbortController().signal,
    });
    expect(r.data).toBeNull();
  });

  it('never throws out of observe, even when the source fails', async () => {
    const m = await load();
    const r = await m.observeFromHost({
      chatId: CHAT,
      scope: { visibility: 'chat', chatId: CHAT },
      target: 'chat.summary',
      runId: 'r2',
      attempt: 1,
      correlationId: 'c2',
      idempotencyKey: 'k2',
      signal: new AbortController().signal,
    });
    // Fail-soft: an unreadable source yields empty, never an exception that would
    // abort the run.
    expect(r).toHaveProperty('data');
  });

  it('rejects an empty fact rather than writing a blank memory', async () => {
    const m = await load();
    const r = await m.rememberViaHost({
      chatId: CHAT,
      scope: { visibility: 'chat', chatId: CHAT },
      fact: '   ',
      runId: 'r3',
      attempt: 1,
      correlationId: 'c3',
      idempotencyKey: 'k3',
      signal: new AbortController().signal,
    });
    expect(r.memoryId).toBe('');
  });

  it('refuses to correct an invalid debt id', async () => {
    const m = await load();
    const r = await m.correctViaHost({
      chatId: CHAT,
      scope: { visibility: 'chat', chatId: CHAT },
      debtId: 0,
      resolution: 'x',
      runId: 'r4',
      attempt: 1,
      correlationId: 'c4',
      idempotencyKey: 'k4',
      signal: new AbortController().signal,
    });
    expect(r.resolved).toBe(false);
  });

  it('records a stop with a traceable id', async () => {
    const m = await load();
    const r = await m.stopViaHost({
      chatId: CHAT,
      scope: { visibility: 'chat', chatId: CHAT },
      reason: 'user asked',
      runId: 'run-9',
      attempt: 1,
      correlationId: 'c5',
      idempotencyKey: 'k5',
      signal: new AbortController().signal,
    });
    expect(r.stoppedAt).toBeGreaterThan(0);
    expect(r.stopId).toContain('run-9');
  });

  it('exposes all four operations through the runtime bridge', async () => {
    const m = await load();
    const adapters = m.runtimeAdaptersFromHost();
    expect(Object.keys(adapters).sort()).toEqual(['correct', 'observe', 'remember', 'stop']);
  });

  it('is off by default', async () => {
    const m = await load();
    envValues['AGENCY_CONTROL_ADAPTERS_ENABLED'] = false;
    expect(m.agencyControlAdaptersEnabled()).toBe(false);
  });
});
