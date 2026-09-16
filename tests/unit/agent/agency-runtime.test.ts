import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  cancelAgencyRun,
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
  executeAgencyRun,
  getAgencyRun,
  recordObservedAgencyOutcome,
} from '../../../src/agent/agency-runtime.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
});

describe('durable agency runtime', () => {
  it('validates a scoped envelope and makes idempotent runs', async () => {
    const envelope = createAgencyEnvelope({
      action: { type: 'speak', text: '已核实' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'reply:task-1:1',
      correlationId: 'task-1',
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.envelope?.risk).toBe('reversible');
    const created = createAgencyRun(envelope.envelope!);
    const reused = createAgencyRun(envelope.envelope!);
    expect(created.ok).toBe(true);
    expect(reused.reused).toBe(true);
    expect(reused.run?.id).toBe(created.run?.id);

    const adapter = vi.fn(async () => ({ messageId: 9 }));
    const result = await executeAgencyRun(created.run!.id, { speak: adapter });
    expect(result.ok).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect((await executeAgencyRun(created.run!.id, { speak: adapter })).reason).toBe('succeeded');
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(getAgencyRun(created.run!.id)?.status).toBe('succeeded');
    expect(db.prepare('SELECT status, attempt_no FROM agency_attempts WHERE run_id = ?').get(created.run!.id)).toMatchObject({ status: 'succeeded', attempt_no: 1 });
    expect(db.prepare('SELECT status, run_id FROM execution_receipts WHERE run_id = ?').get(created.run!.id)).toMatchObject({ status: 'succeeded', run_id: created.run!.id });
  });

  it('fails closed without an adapter and rejects global side-effect envelopes', async () => {
    const invalid = createAgencyEnvelope({ action: { type: 'speak', text: 'x' }, scope: { visibility: 'global' }, idempotencyKey: 'global-speak' });
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toBe('scoped_chat_required');
    const envelope = createAgencyEnvelope({ action: { type: 'observe', target: 'status' }, scope: { visibility: 'chat', chatId: -100 }, idempotencyKey: 'observe:1' });
    const run = createAgencyRun(envelope.envelope!);
    const result = await executeAgencyRun(run.run!.id, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no adapter');
    expect(result.run?.status).toBe('failed');
    expect(db.prepare('SELECT status FROM agency_attempts WHERE run_id = ?').get(run.run!.id)).toEqual({ status: 'failed' });
    expect(db.prepare('SELECT status FROM execution_receipts WHERE run_id = ?').get(run.run!.id)).toEqual({ status: 'failed' });
  });

  it('fails closed when a malformed adapter map is supplied after claim', async () => {
    const envelope = createAgencyEnvelope({
      action: { type: 'observe', target: 'status' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'malformed-adapters:1',
    });
    const run = createAgencyRun(envelope.envelope!);

    const result = await executeAgencyRun(run.run!.id, null as never);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no adapter');
    expect(result.run?.status).toBe('failed');
    expect(db.prepare('SELECT status FROM agency_attempts WHERE run_id = ?').get(run.run!.id)).toEqual({ status: 'failed' });
    expect(db.prepare('SELECT status FROM execution_receipts WHERE run_id = ?').get(run.run!.id)).toEqual({ status: 'failed' });
  });

  it('revalidates envelopes before persistence', () => {
    const valid = createAgencyEnvelope({
      action: { type: 'observe', target: 'status' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'invalid-envelope:1',
    }).envelope!;
    expect(createAgencyRun({ ...valid, risk: 'irreversible' }).reason).toBe('risk_mismatch');
    expect(createAgencyRun({ ...valid, scope: { visibility: 'global' } }).reason).toBe('scoped_chat_required');
    expect(createAgencyRun({ ...valid, budget: { ...valid.budget, maxMs: 0 } }).reason).toBe('invalid_budget');
  });

  it('uses the default shadow policy before invoking an adapter', async () => {
    const envelope = createAgencyEnvelope({
      action: { type: 'speak', text: 'should wait' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'shadow:1',
    });
    const run = createAgencyRun(envelope.envelope!);
    const adapter = vi.fn(async () => ({ messageId: 1 }));
    const result = await dispatchAgencyRun(run.run!.id, { speak: adapter });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('policy:shadow_only');
    expect(result.run?.status).toBe('waiting');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('cancels a pending run before dispatch', () => {
    const envelope = createAgencyEnvelope({ action: { type: 'wait', reason: '稍后再看' }, scope: { visibility: 'chat', chatId: -100 }, idempotencyKey: 'wait:1' });
    const run = createAgencyRun(envelope.envelope!);
    const cancelled = cancelAgencyRun(run.run!.id, 'user stopped');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.run?.status).toBe('cancelled');
    expect(db.prepare('SELECT status FROM execution_receipts WHERE run_id = ?').get(run.run!.id)).toEqual({ status: 'cancelled' });
  });

  it('enforces adapter-side LLM/tool counters at runtime', async () => {
    const envelope = createAgencyEnvelope({
      action: { type: 'act', goal: '有限工具任务' },
      scope: { visibility: 'task', chatId: -100, taskId: 'task-budget' },
      idempotencyKey: 'budget:1',
      budget: { maxLlmCalls: 1, maxToolCalls: 1 },
    });
    const run = createAgencyRun(envelope.envelope!);
    const adapter = vi.fn(async (_action, context) => {
      context.usage.consumeToolCall();
      context.usage.consumeToolCall();
      return { ok: true };
    });
    const result = await executeAgencyRun(run.run!.id, { act: adapter });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tool budget exceeded');
    expect(result.run?.status).toBe('failed');
    expect(adapter).toHaveBeenCalledOnce();
  });

  it('does not write an expired receipt after a concurrent cancellation wins', async () => {
    const now = Math.floor(Date.now() / 1000);
    const envelope = createAgencyEnvelope({
      action: { type: 'wait', reason: '过期后不应执行' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'expired-race:1',
    }).envelope!;
    db.prepare(`INSERT INTO agency_runs
      (id, correlation_id, scope_key, visibility, chat_id, action_json, risk, idempotency_key,
       max_ms, max_llm_calls, max_tool_calls, expires_at, status, attempt, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
      .run(envelope.id, envelope.correlationId, 'chat:-100', 'chat', -100, JSON.stringify(envelope.action), envelope.risk,
        envelope.idempotencyKey, envelope.budget.maxMs, envelope.budget.maxLlmCalls, envelope.budget.maxToolCalls, now - 1, now - 2, now - 2);
    db.exec(`CREATE TRIGGER agency_expiry_race BEFORE UPDATE OF status ON agency_runs
      WHEN NEW.status = 'expired'
      BEGIN
        UPDATE agency_runs SET status = 'cancelled', error = 'user stopped', updated_at = unixepoch(), finished_at = unixepoch() WHERE id = OLD.id;
        SELECT RAISE(IGNORE);
      END`);

    const result = await executeAgencyRun(envelope.id, {});
    expect(result.reason).toBe('cancelled');
    expect(result.run?.status).toBe('cancelled');
    expect(db.prepare('SELECT COUNT(*) AS count FROM execution_receipts WHERE run_id = ?').get(envelope.id)).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_attempts WHERE run_id = ?').get(envelope.id)).toEqual({ count: 0 });
  });

  it('settles a legacy delivery from an observed host receipt without invoking an adapter', () => {
    const envelope = createAgencyEnvelope({
      action: { type: 'speak', text: 'legacy output' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'observed-delivery:1',
    });
    const created = createAgencyRun(envelope.envelope!);

    const settled = recordObservedAgencyOutcome({
      runId: created.run!.id,
      status: 'succeeded',
      result: { messageId: 777 },
    });

    expect(settled.ok).toBe(true);
    expect(settled.run?.status).toBe('succeeded');
    expect(db.prepare('SELECT status, attempt_no FROM agency_attempts WHERE run_id = ?').get(created.run!.id)).toMatchObject({ status: 'succeeded', attempt_no: 1 });
    expect(db.prepare('SELECT status, result_json FROM execution_receipts WHERE run_id = ?').get(created.run!.id)).toMatchObject({ status: 'succeeded', result_json: '{"messageId":777}' });
    const event = db.prepare("SELECT fact_json FROM cognitive_events WHERE correlation_id = ? AND type = 'bot_delivery' ORDER BY sequence DESC LIMIT 1").get(created.run!.envelope.correlationId) as { fact_json: string };
    expect(JSON.parse(event.fact_json)).toMatchObject({ state: 'succeeded', messageId: 777, observed: true });

    const replay = recordObservedAgencyOutcome({
      runId: created.run!.id,
      status: 'succeeded',
      result: { messageId: 777 },
    });
    expect(replay.ok).toBe(true);
    expect(replay.reason).toBe('succeeded');
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_attempts WHERE run_id = ?').get(created.run!.id)).toEqual({ count: 1 });
  });

  it('rejects invalid observed receipts and unsupported actions before claiming a run', () => {
    const speak = createAgencyRun(createAgencyEnvelope({
      action: { type: 'speak', text: 'missing receipt' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'observed-invalid:1',
    }).envelope!);
    const invalid = recordObservedAgencyOutcome({
      runId: speak.run!.id,
      status: 'succeeded',
      result: { messageId: 0 },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toBe('observed delivery requires a valid messageId');
    expect(getAgencyRun(speak.run!.id)?.status).toBe('pending');

    const observe = createAgencyRun(createAgencyEnvelope({
      action: { type: 'observe', target: 'not a delivery' },
      scope: { visibility: 'chat', chatId: -100 },
      idempotencyKey: 'observed-invalid:2',
    }).envelope!);
    const unsupported = recordObservedAgencyOutcome({
      runId: observe.run!.id,
      status: 'succeeded',
      result: { messageId: 1 },
    });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.reason).toBe('observed outcome only supports speak/ask');
    expect(getAgencyRun(observe.run!.id)?.status).toBe('pending');
  });
});
