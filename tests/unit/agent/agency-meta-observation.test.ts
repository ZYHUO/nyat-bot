import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
  envState: {
    AGENCY_RUNTIME_MODE: 'shadow' as string,
    AGENCY_CANARY_CHAT_IDS: [] as number[],
    AGENCY_MAX_LLM_CALLS: 2,
    AGENCY_MAX_TOOL_CALLS: 8,
    AGENCY_FAIL_CLOSED: true,
  },
}));

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAgencyRun, listAgencyRunSummaries } from '../../../src/agent/agency-runtime.js';
import { recordMetaDispatchObservation } from '../../../src/agent/agency-meta-observation.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0092_agency_runs.sql', 'utf8'));
  db.exec(readFileSync('migrations/0095_agency_attempts_receipts.sql', 'utf8'));
  envState.AGENCY_RUNTIME_MODE = 'shadow';
});

describe('Meta dispatch Agency observation bridge', () => {
  it('persists bounded structured intent and defers it in shadow mode', async () => {
    const result = await recordMetaDispatchObservation({
      chatId: -100,
      layer: 'L1',
      quoteMessageIds: [11, 0, -2, 12],
      relatedQuoteCount: Number.NaN,
      taskId: ' task-1 ',
      targetUserId: 42,
      interrupt: true,
      cognitiveAnchorEventId: ' cognitive-event-1 ',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'waiting',
      deferred: true,
      reused: false,
      reason: 'policy:shadow_only',
    });
    const row = db.prepare('SELECT * FROM agency_runs WHERE id = ?').get(result.runId) as Record<string, unknown>;
    expect(row).toMatchObject({
      status: 'waiting',
      chat_id: -100,
      visibility: 'task',
      task_id: 'task-1',
      causation_id: 'cognitive-event-1',
      idempotency_key: 'meta-dispatch:-100:message:11:L1',
    });
    expect(JSON.parse(String(row.action_json))).toEqual({
      type: 'observe',
      target: 'meta:dispatch.taskToGroup',
      args: {
        layer: 'L1',
        quoteMessageIds: [11, 12],
        relatedQuoteCount: 0,
        interrupt: true,
        decision: 'proposed',
        taskId: 'task-1',
        targetUserId: 42,
      },
    });
    expect(JSON.parse(String(row.expected_outcome))).toEqual({
      kind: 'meta_dispatch_proposal',
      layer: 'L1',
      quoteMessageIds: [11, 12],
      relatedQuoteCount: 0,
      decision: 'proposed',
      taskId: 'task-1',
    });
    expect(String(row.expected_outcome).length).toBeLessThanOrEqual(500);

    const [summary] = listAgencyRunSummaries({ chatId: -100, limit: 1 });
    expect(summary).toMatchObject({
      id: result.runId,
      actionType: 'observe',
      actionTarget: 'meta:dispatch.taskToGroup',
      status: 'waiting',
      error: 'policy:shadow_only',
    });
    expect(summary).not.toHaveProperty('actionArgs');
    expect(summary).not.toHaveProperty('result');
  });

  it('reuses the same trigger/layer run without creating a second proposal', async () => {
    const input = {
      chatId: -100,
      layer: 'L0' as const,
      quoteMessageIds: [21],
      taskId: 'task-retry',
    };
    const first = await recordMetaDispatchObservation(input);
    const second = await recordMetaDispatchObservation(input);

    expect(first.runId).toBe(second.runId);
    expect(second.reused).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_runs').get()).toEqual({ count: 1 });
    expect(getAgencyRun(first.runId!)?.status).toBe('waiting');
  });

  it('executes only the metadata adapter in advisory mode', async () => {
    envState.AGENCY_RUNTIME_MODE = 'advisory';
    const result = await recordMetaDispatchObservation({
      chatId: -100,
      layer: 'L1_CALLBACK',
      quoteMessageIds: [31],
    });

    expect(result).toMatchObject({ ok: true, status: 'succeeded', deferred: false });
    expect(getAgencyRun(result.runId!)?.result).toEqual({
      recorded: true,
      target: 'meta:dispatch.taskToGroup',
    });
  });

  it.each([
    ['invalid chat', { chatId: 0, layer: 'L0', quoteMessageIds: [1] }, 'invalid_chat_id'],
    ['invalid layer', { chatId: -100, layer: 'bad', quoteMessageIds: [1] }, 'invalid_attention_layer'],
    ['missing dispatch anchor', { chatId: -100, layer: 'L0', quoteMessageIds: [] }, 'missing_dispatch_anchor'],
    ['invalid anchor', { chatId: -100, layer: 'L0', quoteMessageIds: [1], cognitiveAnchorEventId: 7 }, 'invalid_cognitive_anchor_event_id'],
    ['invalid target user', { chatId: -100, layer: 'L0', quoteMessageIds: [1], targetUserId: 0 }, 'invalid_target_user_id'],
  ])('rejects %s before persistence', async (_label, input, reason) => {
    const result = await recordMetaDispatchObservation(input as never);
    expect(result).toEqual({ ok: false, reason });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agency_runs').get()).toEqual({ count: 0 });
  });

  it('degrades cleanly when the Agency migration is unavailable', async () => {
    db.exec('DROP TABLE agency_runs');

    const result = await recordMetaDispatchObservation({
      chatId: -100,
      layer: 'L2',
      quoteMessageIds: [41],
      interrupt: true,
    });

    expect(result).toEqual({ ok: false, reason: 'agency_runs_unavailable' });
  });

  it('records proactive task intent without a quote message', async () => {
    const result = await recordMetaDispatchObservation({
      chatId: -100,
      layer: 'L2',
      quoteMessageIds: [],
      taskId: 'proactive-task-1',
      interrupt: true,
    });

    expect(result).toMatchObject({ ok: true, status: 'waiting' });
    const row = db.prepare('SELECT * FROM agency_runs WHERE id = ?').get(result.runId) as Record<string, unknown>;
    expect(row).toMatchObject({
      visibility: 'task',
      chat_id: -100,
      task_id: 'proactive-task-1',
      correlation_id: 'meta:chat:-100:task:proactive-task-1:dispatch',
    });
    expect(JSON.parse(String(row.action_json))).toMatchObject({
      type: 'observe',
      target: 'meta:dispatch.taskToGroup',
      args: expect.objectContaining({ quoteMessageIds: [], taskId: 'proactive-task-1' }),
    });
  });
});
