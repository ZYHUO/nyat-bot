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

import { createAgencyEnvelope, createAgencyRun, dispatchAgencyRun } from '../../../src/agent/agency-runtime.js';
import {
  createAgencyCorrectAdapters,
  createAgencyObserveAdapters,
  createAgencyRememberAdapters,
  createAgencyStopAdapters,
} from '../../../src/agent/agency-control-adapters.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
  envState.AGENCY_RUNTIME_MODE = 'authority';
});

function createRun(action: unknown, idempotencyKey: string) {
  const envelope = createAgencyEnvelope({
    action,
    scope: { visibility: 'chat', chatId: -100 },
    idempotencyKey,
    correlationId: 'corr:control',
    budget: { maxLlmCalls: 0, maxToolCalls: 1 },
  });
  expect(envelope.ok).toBe(true);
  const run = createAgencyRun(envelope.envelope!);
  expect(run.ok).toBe(true);
  return run.run!;
}

describe('explicit Agency control adapters', () => {
  it('records a scoped observation through the host callback', async () => {
    const observe = vi.fn(async () => ({ data: { online: true } }));
    const run = createRun({ type: 'observe', target: 'chat.status', args: { chatId: -100 } }, 'control:observe');

    const result = await dispatchAgencyRun(run.id, createAgencyObserveAdapters(observe));

    expect(result.ok).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100,
      scope: { visibility: 'chat', chatId: -100 },
      target: 'chat.status',
      args: { chatId: -100 },
      runId: run.id,
      attempt: 1,
      correlationId: 'corr:control',
      idempotencyKey: 'control:observe',
      signal: expect.any(AbortSignal),
    }));
    expect(result.run?.result).toEqual({ data: { online: true } });
  });

  it('requires a durable memory id for remember', async () => {
    const remember = vi.fn(async () => ({ memoryId: 'mem-1' }));
    const run = createRun({ type: 'remember', fact: '用户偏好简短回答' }, 'control:remember');

    const result = await dispatchAgencyRun(run.id, createAgencyRememberAdapters(remember));

    expect(result.ok).toBe(true);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ chatId: -100, fact: '用户偏好简短回答' }));
    expect(result.run?.result).toEqual({ memoryId: 'mem-1' });
  });

  it('only settles correction when the host confirms evidence resolution', async () => {
    const correct = vi.fn(async () => ({ resolved: true, resolutionEventId: 'evt-correct-1' }));
    const run = createRun({ type: 'correct', debtId: 7, resolution: '用户提供了新的来源' }, 'control:correct');

    const result = await dispatchAgencyRun(run.id, createAgencyCorrectAdapters(correct));

    expect(result.ok).toBe(true);
    expect(correct).toHaveBeenCalledWith(expect.objectContaining({ chatId: -100, debtId: 7, resolution: '用户提供了新的来源' }));
    expect(result.run?.result).toEqual({ resolved: true, resolutionEventId: 'evt-correct-1' });
  });

  it('requires a durable stop receipt for the irreversible action', async () => {
    const stop = vi.fn(async () => ({ stoppedAt: 1_900_000_000_000, stopId: 'stop-1' }));
    const run = createRun({ type: 'stop', reason: '用户明确要求停止' }, 'control:stop');

    const result = await dispatchAgencyRun(run.id, createAgencyStopAdapters(stop));

    expect(result.ok).toBe(true);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ chatId: -100, reason: '用户明确要求停止' }));
    expect(result.run?.result).toEqual({ stoppedAt: 1_900_000_000_000, stopId: 'stop-1' });
  });

  it('fails closed when correction evidence is rejected', async () => {
    const correct = vi.fn(async () => ({ resolved: false, resolutionEventId: 'evt-rejected' }));
    const run = createRun({ type: 'correct', debtId: 8, resolution: '未能核实' }, 'control:correct-rejected');

    const result = await dispatchAgencyRun(run.id, createAgencyCorrectAdapters(correct));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('correction was not accepted');
    expect(result.run?.status).toBe('failed');
  });

  it('rejects unscoped calls before invoking any host callback', async () => {
    const stop = vi.fn(async () => ({ stoppedAt: 1_900_000_000_000 }));
    const adapter = createAgencyStopAdapters(stop).stop!;
    const context = {
      runId: 'run-direct',
      attempt: 1,
      correlationId: 'corr:direct',
      idempotencyKey: 'direct:stop',
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

    await expect(adapter({ type: 'stop', reason: 'blocked' }, context)).rejects.toThrow('scoped chat');
    expect(stop).not.toHaveBeenCalled();
  });
});
