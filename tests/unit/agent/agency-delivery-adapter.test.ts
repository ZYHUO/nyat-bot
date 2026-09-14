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

import { createAgencyDeliveryAdapters, createTelegramAgencyDeliveryAdapters, type AgencyAdapterContext } from '../../../src/agent/agency-delivery-adapter.js';
import { createAgencyEnvelope, createAgencyRun, dispatchAgencyRun, executeAgencyRun } from '../../../src/agent/agency-runtime.js';

const telegramSendDirect = vi.fn(async (_chatId: number, _text: string, _replyTo?: number) => ({ messageId: 95 }));
vi.mock('../../../src/pipeline/shared.js', () => ({
  sender: { sendDirect: (...args: unknown[]) => telegramSendDirect(...(args as [number, string, number?])) },
}));

beforeEach(() => {
  envState.AGENCY_RUNTIME_MODE = 'authority';
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
});

function createRun(action: unknown, idempotencyKey: string) {
  const envelope = createAgencyEnvelope({
    action,
    scope: { visibility: 'chat', chatId: -100 },
    idempotencyKey,
    correlationId: 'corr:delivery',
    budget: { maxLlmCalls: 0, maxToolCalls: 1 },
  });
  expect(envelope.ok).toBe(true);
  const run = createAgencyRun(envelope.envelope!);
  expect(run.ok).toBe(true);
  return run.run!;
}

describe('explicit Agency delivery adapters', () => {
  it('passes scope and durable dedupe metadata to the host sender', async () => {
    const deliver = vi.fn(async () => ({ messageId: 91 }));
    const adapters = createAgencyDeliveryAdapters(deliver);
    const run = createRun({ type: 'speak', text: '  已核实  ', replyToMessageId: 12 }, 'delivery:speak:1');

    const result = await dispatchAgencyRun(run.id, adapters);

    expect(result.ok).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100,
      scope: { visibility: 'chat', chatId: -100 },
      text: '已核实',
      replyToMessageId: 12,
      runId: run.id,
      attempt: 1,
      correlationId: 'corr:delivery',
      idempotencyKey: 'delivery:speak:1',
      signal: expect.any(AbortSignal),
    }));
    expect(result.run?.result).toEqual({ messageId: 91 });
    expect((db.prepare('SELECT status, result_json FROM execution_receipts WHERE run_id = ?').get(run.id) as { status: string; result_json: string }).status).toBe('succeeded');
  });

  it('maps ask to the same transport contract and counts one tool call', async () => {
    const deliver = vi.fn(async () => ({ messageId: 92 }));
    const run = createRun({ type: 'ask', question: '需要补充来源吗？' }, 'delivery:ask:1');

    const result = await executeAgencyRun(run.id, createAgencyDeliveryAdapters(deliver));

    expect(result.ok).toBe(true);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ chatId: -100, text: '需要补充来源吗？' }));
    const event = db.prepare("SELECT fact_json FROM cognitive_events WHERE type = 'bot_delivery' AND correlation_id = ?").get('corr:delivery') as { fact_json: string };
    expect(JSON.parse(event.fact_json)).toMatchObject({ state: 'succeeded', toolCalls: 1, messageId: 92 });
  });

  it('fails closed on an invalid transport receipt', async () => {
    const deliver = vi.fn(async () => ({ messageId: 0 }));
    const run = createRun({ type: 'speak', text: '不会确认成功' }, 'delivery:bad-receipt:1');

    const result = await executeAgencyRun(run.id, createAgencyDeliveryAdapters(deliver));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid delivery receipt');
    expect(result.run?.status).toBe('failed');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('rejects an unscoped direct adapter call before invoking transport', async () => {
    const deliver = vi.fn(async () => ({ messageId: 93 }));
    const adapters = createAgencyDeliveryAdapters(deliver);
    const context: AgencyAdapterContext = {
      runId: 'run-direct',
      attempt: 1,
      correlationId: 'corr:direct',
      idempotencyKey: 'direct:1',
      scope: { visibility: 'global' },
      signal: new AbortController().signal,
      budget: { maxMs: 1000, maxLlmCalls: 0, maxToolCalls: 1 },
      usage: {
        llmCalls: 0,
        toolCalls: 0,
        consumeLlmCall: () => 1,
        consumeToolCall: () => 1,
      },
    };

    await expect(adapters.speak!({ type: 'speak', text: 'blocked' }, context)).rejects.toThrow('scoped chat');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not invoke the sender in shadow mode', async () => {
    envState.AGENCY_RUNTIME_MODE = 'shadow';
    const deliver = vi.fn(async () => ({ messageId: 94 }));
    const run = createRun({ type: 'speak', text: 'shadow' }, 'delivery:shadow:1');

    const result = await dispatchAgencyRun(run.id, createAgencyDeliveryAdapters(deliver));

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('policy:shadow_only');
    expect(result.run?.status).toBe('waiting');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('binds the explicit factory to Telegram sender only when dispatched', async () => {
    telegramSendDirect.mockClear();
    const run = createRun({ type: 'speak', text: '显式 Telegram adapter' }, 'delivery:telegram:1');

    const result = await dispatchAgencyRun(run.id, createTelegramAgencyDeliveryAdapters());

    expect(result.ok).toBe(true);
    expect(telegramSendDirect).toHaveBeenCalledWith(-100, '显式 Telegram adapter', undefined);
  });
});
