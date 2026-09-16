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
};

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const enqueueCodeActJobMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/subagent/queue.js', () => ({
  enqueueCodeActJob: (...args: unknown[]) => enqueueCodeActJobMock(...args),
}));

import { createAgencyActAdapters } from '../../../src/agent/agency-act-adapter.js';
import { createAgencyEnvelope, createAgencyRun, dispatchAgencyRun } from '../../../src/agent/agency-runtime.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
  envState.AGENCY_RUNTIME_MODE = 'authority';
  enqueueCodeActJobMock.mockClear();
});

function createRun(action: unknown, idempotencyKey: string) {
  const envelope = createAgencyEnvelope({
    action,
    scope: { visibility: 'task', chatId: -100, taskId: 'task-parent' },
    idempotencyKey,
    correlationId: 'corr:act',
    budget: { maxLlmCalls: 0, maxToolCalls: 1 },
  });
  expect(envelope.ok).toBe(true);
  const run = createAgencyRun(envelope.envelope!);
  expect(run.ok).toBe(true);
  return run.run!;
}

describe('explicit Agency act adapter', () => {
  it('passes task scope and durable metadata to the CodeAct host', async () => {
    const start = vi.fn(async () => ({ taskId: 'task-child', acceptedAt: 1_900_000_000_000, queueJobId: 'job-1' }));
    const run = createRun({ type: 'act', goal: '整理并核验资料', taskId: ' requested-child ' }, 'act:1');

    const result = await dispatchAgencyRun(run.id, createAgencyActAdapters(start));

    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100,
      scope: { visibility: 'task', chatId: -100, taskId: 'task-parent' },
      goal: '整理并核验资料',
      requestedTaskId: 'requested-child',
      runId: run.id,
      attempt: 1,
      correlationId: 'corr:act',
      idempotencyKey: 'act:1',
      signal: expect.any(AbortSignal),
    }));
    expect(result.run?.result).toEqual({ taskId: 'task-child', acceptedAt: 1_900_000_000_000, queueJobId: 'job-1' });
    expect(db.prepare('SELECT status FROM execution_receipts WHERE run_id = ?').get(run.id)).toEqual({ status: 'succeeded' });
  });

  it('fails closed when the host does not return a durable task receipt', async () => {
    const start = vi.fn(async () => ({ taskId: '', acceptedAt: 0 }));
    const run = createRun({ type: 'act', goal: '不能伪造任务已接受' }, 'act:bad-receipt');

    const result = await dispatchAgencyRun(run.id, createAgencyActAdapters(start));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid act receipt');
    expect(result.run?.status).toBe('failed');
  });

  it('rejects unscoped calls before queue submission', async () => {
    const start = vi.fn(async () => ({ taskId: 'task-1', acceptedAt: 1_900_000_000_000 }));
    const adapter = createAgencyActAdapters(start).act!;
    const context = {
      runId: 'run-direct',
      attempt: 1,
      correlationId: 'corr:direct',
      idempotencyKey: 'direct:act',
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

    await expect(adapter({ type: 'act', goal: 'blocked' }, context)).rejects.toThrow('scoped chat');
    expect(start).not.toHaveBeenCalled();
  });

  it('does not submit a cancelled task or consume tool budget', async () => {
    const start = vi.fn(async () => ({ taskId: 'task-1', acceptedAt: 1_900_000_000_000 }));
    const adapter = createAgencyActAdapters(start).act!;
    const controller = new AbortController();
    controller.abort();
    let consumed = 0;
    const context = {
      runId: 'run-cancelled',
      attempt: 1,
      correlationId: 'corr:cancelled',
      idempotencyKey: 'cancelled:act',
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

    await expect(adapter({ type: 'act', goal: 'cancelled' }, context)).rejects.toThrow('cancelled');
    expect(start).not.toHaveBeenCalled();
    expect(consumed).toBe(0);
  });

  it('rejects malformed optional task and queue identifiers', async () => {
    const start = vi.fn(async () => ({ taskId: 'task-1', acceptedAt: 1_900_000_000_000 }));
    const adapter = createAgencyActAdapters(start).act!;
    const base = {
      runId: 'run-direct',
      attempt: 1,
      correlationId: 'corr:direct',
      idempotencyKey: 'direct:act',
      scope: { visibility: 'chat' as const, chatId: -100 },
      signal: new AbortController().signal,
      budget: { maxMs: 1000, maxLlmCalls: 0, maxToolCalls: 1 },
      usage: { llmCalls: 0, toolCalls: 0, consumeLlmCall: () => 1, consumeToolCall: () => 1 },
    };
    await expect(adapter({ type: 'act', goal: 'goal', taskId: ' ' }, base)).rejects.toThrow('invalid requested task id');

    const badReceipt = vi.fn(async () => ({ taskId: 'task-1', acceptedAt: 1_900_000_000_000, queueJobId: ' ' }));
    await expect(createAgencyActAdapters(badReceipt).act!({ type: 'act', goal: 'goal' }, base)).rejects.toThrow('invalid act queue job id');
  });

  it('does not invoke the adapter in shadow mode', async () => {
    envState.AGENCY_RUNTIME_MODE = 'shadow';
    const start = vi.fn(async () => ({ taskId: 'task-shadow', acceptedAt: 1_900_000_000_000 }));
    const run = createRun({ type: 'act', goal: 'shadow' }, 'act:shadow');

    const result = await dispatchAgencyRun(run.id, createAgencyActAdapters(start));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('policy:shadow_only');
    expect(result.run?.status).toBe('waiting');
    expect(start).not.toHaveBeenCalled();
  });

  it('binds the explicit factory to the existing CodeAct queue only on dispatch', async () => {
    const { createCodeActAgencyActAdapters } = await import('../../../src/agent/agency-act-adapter.js');
    const run = createRun({ type: 'act', goal: '通过现有队列执行', taskId: 'task-bound' }, 'act:queue-binding');

    const result = await dispatchAgencyRun(run.id, createCodeActAgencyActAdapters());

    expect(result.ok).toBe(true);
    expect(enqueueCodeActJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-bound',
      chatId: -100,
      contentDirection: '通过现有队列执行',
      status: 'queued',
    }));
    expect(result.run?.result).toMatchObject({ taskId: 'task-bound' });
  });

  it('preserves a pipeline task template when the queue binding is used', async () => {
    const { createCodeActAgencyActAdapters } = await import('../../../src/agent/agency-act-adapter.js');
    const template = {
      id: 'task-template',
      chatId: -100,
      contentDirection: 'old direction',
      createdAt: 1_900_000_000_000,
      status: 'running' as const,
      quoteMessageIds: [42],
      relatedQuoteIds: [43],
      targetUserId: 7,
      acceptance: { source: 'caller' as const, checks: [{ kind: 'nonempty_file' as const, path: 'answer.txt' }] },
      segment: 2,
    };
    const run = createRun({ type: 'act', goal: 'new direction', taskId: 'task-template' }, 'act:template');

    const result = await dispatchAgencyRun(run.id, createCodeActAgencyActAdapters(template));

    expect(result.ok).toBe(true);
    expect(enqueueCodeActJobMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-template',
      chatId: -100,
      contentDirection: 'new direction',
      status: 'queued',
      quoteMessageIds: [42],
      relatedQuoteIds: [43],
      targetUserId: 7,
      acceptance: template.acceptance,
      segment: 2,
    }));
  });
});
