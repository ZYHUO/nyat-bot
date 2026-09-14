import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
const envState: Record<string, unknown> = {
  AGENCY_RUNTIME_MODE: 'authority',
  AGENCY_CANARY_CHAT_IDS: [],
  AGENCY_MAX_LLM_CALLS: 2,
  AGENCY_MAX_TOOL_CALLS: 8,
  AGENCY_FAIL_CLOSED: true,
  TIMING_GATE_ENABLED: true,
  TIMING_WAIT_MIN_SEC: 5,
};

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { transitionToWaitMock, getChatStateMock } = vi.hoisted(() => ({
  transitionToWaitMock: vi.fn(async () => undefined),
  getChatStateMock: vi.fn(async () => ({ state: 'WAIT', waitUntil: 1_900_000_000_000, waitJobId: 'timing-job-1' })),
}));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  transitionToWait: (...args: unknown[]) => transitionToWaitMock(...args),
  getChatState: (...args: unknown[]) => getChatStateMock(...args),
}));

import { createAgencyEnvelope, createAgencyRun, dispatchAgencyRun } from '../../../src/agent/agency-runtime.js';
import { createAgencyWaitAdapters } from '../../../src/agent/agency-wait-adapter.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
  envState.AGENCY_RUNTIME_MODE = 'authority';
  envState.TIMING_GATE_ENABLED = true;
  transitionToWaitMock.mockClear();
  getChatStateMock.mockClear();
});

function createRun(action: unknown, idempotencyKey: string) {
  const envelope = createAgencyEnvelope({
    action,
    scope: { visibility: 'chat', chatId: -100 },
    idempotencyKey,
    correlationId: 'corr:wait',
    budget: { maxLlmCalls: 0, maxToolCalls: 1 },
  });
  expect(envelope.ok).toBe(true);
  const run = createAgencyRun(envelope.envelope!);
  expect(run.ok).toBe(true);
  return run.run!;
}

describe('explicit Agency wait adapter', () => {
  it('passes scoped scheduling metadata and returns a durable wait receipt', async () => {
    const schedule = vi.fn(async () => ({ waitUntil: 1_900_000_000_000, waitJobId: 'wait-job-1' }));
    const run = createRun({ type: 'wait', reason: '等待补充上下文', waitSec: 12.8 }, 'wait:1');

    const result = await dispatchAgencyRun(run.id, createAgencyWaitAdapters(schedule));

    expect(result.ok).toBe(true);
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100,
      scope: { visibility: 'chat', chatId: -100 },
      reason: '等待补充上下文',
      waitSec: 12,
      runId: run.id,
      attempt: 1,
      correlationId: 'corr:wait',
      idempotencyKey: 'wait:1',
      signal: expect.any(AbortSignal),
    }));
    expect(result.run?.result).toEqual({ waitUntil: 1_900_000_000_000, waitJobId: 'wait-job-1' });
    expect(db.prepare('SELECT status, result_json FROM execution_receipts WHERE run_id = ?').get(run.id)).toMatchObject({
      status: 'succeeded',
      result_json: '{"waitUntil":1900000000000,"waitJobId":"wait-job-1"}',
    });
  });

  it('fails closed on an invalid scheduler receipt', async () => {
    const schedule = vi.fn(async () => ({ waitUntil: 0 }));
    const run = createRun({ type: 'wait', reason: '无效回执' }, 'wait:bad-receipt');

    const result = await dispatchAgencyRun(run.id, createAgencyWaitAdapters(schedule));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid wait receipt');
    expect(result.run?.status).toBe('failed');
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('rejects an unscoped adapter call before scheduling', async () => {
    const schedule = vi.fn(async () => ({ waitUntil: 1_900_000_000_000 }));
    const adapters = createAgencyWaitAdapters(schedule);
    const context = {
      runId: 'run-direct',
      attempt: 1,
      correlationId: 'corr:direct',
      idempotencyKey: 'direct:wait',
      scope: { visibility: 'global' as const },
      signal: new AbortController().signal,
      budget: { maxMs: 1000, maxLlmCalls: 0, maxToolCalls: 1 },
      usage: {
        llmCalls: 0,
        toolCalls: 0,
        consumeLlmCall: () => 1,
        consumeToolCall: () => 1,
      },
    };

    await expect(adapters.wait!({ type: 'wait', reason: 'blocked' }, context)).rejects.toThrow('scoped chat');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does not schedule after cancellation and does not consume tool budget', async () => {
    const schedule = vi.fn(async () => ({ waitUntil: 1_900_000_000_000 }));
    const adapters = createAgencyWaitAdapters(schedule);
    const controller = new AbortController();
    controller.abort();
    let consumed = 0;
    const context = {
      runId: 'run-cancelled',
      attempt: 1,
      correlationId: 'corr:cancelled',
      idempotencyKey: 'cancelled:wait',
      scope: { visibility: 'chat' as const, chatId: -100 },
      signal: controller.signal,
      budget: { maxMs: 1000, maxLlmCalls: 0, maxToolCalls: 1 },
      usage: {
        llmCalls: 0,
        toolCalls: 0,
        consumeLlmCall: () => 1,
        consumeToolCall: () => { consumed += 1; return consumed; },
      },
    };

    await expect(adapters.wait!({ type: 'wait', reason: 'cancelled' }, context)).rejects.toThrow('cancelled');
    expect(schedule).not.toHaveBeenCalled();
    expect(consumed).toBe(0);
  });

  it('binds the existing timing FSM only when it reports WAIT', async () => {
    const { createTimingAgencyWaitAdapters } = await import('../../../src/agent/agency-wait-adapter.js');
    const run = createRun({ type: 'wait', reason: '使用现有状态机' }, 'wait:timing-binding');

    const result = await dispatchAgencyRun(run.id, createTimingAgencyWaitAdapters());

    expect(result.ok).toBe(true);
    expect(transitionToWaitMock).toHaveBeenCalledWith(-100, 5);
    expect(getChatStateMock).toHaveBeenCalledWith(-100);
    expect(result.run?.result).toEqual({ waitUntil: 1_900_000_000_000, waitJobId: 'timing-job-1' });
  });

  it('fails closed when the timing gate is disabled', async () => {
    envState.TIMING_GATE_ENABLED = false;
    const { createTimingAgencyWaitAdapters } = await import('../../../src/agent/agency-wait-adapter.js');
    const run = createRun({ type: 'wait', reason: '不能静默伪造等待' }, 'wait:timing-disabled');

    const result = await dispatchAgencyRun(run.id, createTimingAgencyWaitAdapters());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timing wait unavailable');
    expect(transitionToWaitMock).not.toHaveBeenCalled();
    expect(getChatStateMock).not.toHaveBeenCalled();
  });
});
