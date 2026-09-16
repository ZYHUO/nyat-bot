import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listCognitiveEvents } from '../../../src/agent/cognitive-events.js';
import {
  emitTaskRuntimeEvent,
  getTaskRecoverySummary,
  listTaskRuntimeEvents,
  replayTaskRuntimeEvents,
  resetTaskRuntimeEvents,
} from '../../../src/agent/task-runtime-events.js';
import { createExecutionAudit } from '../../../src/agent/execution-audit.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0072_task_evidence.sql', 'utf8'));
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  resetTaskRuntimeEvents();
});

describe('durable task runtime events', () => {
  it('persists lifecycle facts while retaining the low-latency emitter', () => {
    emitTaskRuntimeEvent({ kind: 'task_started', taskId: 'task-1', chatId: -100, at: 1_700_000_000_000 });
    emitTaskRuntimeEvent({ kind: 'tool_started', taskId: 'task-1', chatId: -100, invocationId: 'call-1', toolName: 'web.search', at: 1_700_000_000_500 });
    emitTaskRuntimeEvent({ kind: 'tool_finished', taskId: 'task-1', chatId: -100, invocationId: 'call-1', toolName: 'web.search', errorCode: 'timeout', at: 1_700_000_001_000 });
    const completedId = emitTaskRuntimeEvent({
      kind: 'task_completed',
      taskId: 'task-1',
      chatId: -100,
      resolution: 'host acceptance passed',
      assessmentStatus: 'verified',
      resultSummary: 'done',
      at: 1_700_000_002_000,
    });
    const events = listCognitiveEvents({ correlationId: 'task:task-1' });
    expect(events.map((event) => event.type)).toEqual(['task_observation', 'task_observation', 'tool_failure', 'task_observation']);
    expect(events[2]?.fact).toMatchObject({ invocationId: 'call-1', toolName: 'web.search', errorCode: 'timeout' });
    expect(events[3]?.fact).toMatchObject({ resolution: 'host acceptance passed', assessmentStatus: 'verified' });
    expect(completedId).toBe(events[3]?.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cognitive_outbox').get()).toEqual({ count: 4 });
  });

  it('wraps host calls with a bounded started/finished pair', async () => {
    const audit = createExecutionAudit('/tmp', undefined, undefined, { taskId: 'task-2', chatId: -100 });
    const tools = audit.wrap('web', { async search() { return 'ok'; } });
    await tools.search();
    const events = listCognitiveEvents({ correlationId: 'task:task-2' });
    expect(events.map((event) => event.fact.kind)).toEqual(['tool_started', 'tool_finished']);
    expect(events[0]?.fact.invocationId).toBe(events[1]?.fact.invocationId);
    expect(events[1]?.fact).not.toHaveProperty('args');
  });

  it('persists model turn boundaries without model content', () => {
    emitTaskRuntimeEvent({
      kind: 'model_turn_started',
      taskId: 'task-turns',
      chatId: -100,
      cognitiveAnchorEventId: 'telegram-event-2',
      turn: 2,
      segment: 1,
      at: 1_700_000_010_000,
    });
    emitTaskRuntimeEvent({
      kind: 'model_turn_finished',
      taskId: 'task-turns',
      chatId: -100,
      cognitiveAnchorEventId: 'telegram-event-2',
      turn: 2,
      segment: 1,
      resultSummary: 'llm_response_received',
      at: 1_700_000_010_500,
    });
    emitTaskRuntimeEvent({
      kind: 'model_turn_started',
      taskId: 'task-turns',
      chatId: -100,
      turn: 3,
      segment: 1,
      at: 1_700_000_011_000,
    });
    emitTaskRuntimeEvent({
      kind: 'model_turn_finished',
      taskId: 'task-turns',
      chatId: -100,
      turn: 3,
      segment: 1,
      errorCode: 'llm_failed',
      resultSummary: 'llm_call_failed',
      at: 1_700_000_011_500,
    });

    const events = listCognitiveEvents({ correlationId: 'task:task-turns' });
    expect(events.map((event) => event.fact.kind)).toEqual([
      'model_turn_started',
      'model_turn_finished',
      'model_turn_started',
      'model_turn_finished',
    ]);
    expect(events[1]?.causationId).toBe('telegram-event-2');
    expect(events[1]?.fact).toMatchObject({ turn: 2, segment: 1, resultSummary: 'llm_response_received' });
    expect(events[3]?.fact).toMatchObject({ turn: 3, segment: 1, errorCode: 'llm_failed' });
    expect(events[1]?.fact).not.toHaveProperty('content');
  });

  it('rebuilds lifecycle metadata from durable events after a restart', async () => {
    emitTaskRuntimeEvent({
      kind: 'task_started',
      taskId: 'task-replay',
      chatId: -100,
      cognitiveAnchorEventId: 'telegram-event-1',
      at: 1_700_000_000_000,
    });
    emitTaskRuntimeEvent({ kind: 'checkpoint_saved', taskId: 'task-replay', chatId: -100, segment: 2, turn: 8, at: 1_700_000_003_000 });
    emitTaskRuntimeEvent({ kind: 'task_completed', taskId: 'task-other', chatId: -200, at: 1_700_000_004_000 });

    const events = listTaskRuntimeEvents('task-replay');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'task_started',
        taskId: 'task-replay',
        chatId: -100,
        cognitiveAnchorEventId: 'telegram-event-1',
        at: 1_700_000_000_000,
      }),
      expect.objectContaining({ kind: 'checkpoint_saved', segment: 2, turn: 8, at: 1_700_000_003_000 }),
    ]);
    expect(listCognitiveEvents({ correlationId: 'task:task-replay' })[0]?.causationId).toBe('telegram-event-1');
    const seen: string[] = [];
    expect(await replayTaskRuntimeEvents('task-replay', (event) => seen.push(event.kind))).toBe(2);
    expect(seen).toEqual(['task_started', 'checkpoint_saved']);
    expect(listTaskRuntimeEvents('task-replay', { afterSequence: 1 })).toHaveLength(1);
  });

  it('summarizes verified completion and long-running progress without content', () => {
    emitTaskRuntimeEvent({ kind: 'task_queued', taskId: 'task-summary', chatId: -100, segment: 0, cognitiveAnchorEventId: 'telegram-1', at: 1_700_000_000_000 });
    emitTaskRuntimeEvent({ kind: 'task_started', taskId: 'task-summary', chatId: -100, segment: 0, at: 1_700_000_000_100 });
    emitTaskRuntimeEvent({ kind: 'model_turn_started', taskId: 'task-summary', chatId: -100, segment: 0, turn: 1, at: 1_700_000_000_200 });
    emitTaskRuntimeEvent({ kind: 'model_turn_finished', taskId: 'task-summary', chatId: -100, segment: 0, turn: 1, resultSummary: 'llm_response_received', at: 1_700_000_000_300 });
    emitTaskRuntimeEvent({ kind: 'checkpoint_saved', taskId: 'task-summary', chatId: -100, segment: 1, turn: 2, at: 1_700_000_001_000 });
    emitTaskRuntimeEvent({ kind: 'task_queued', taskId: 'task-summary', chatId: -100, segment: 1, at: 1_700_000_001_100 });
    emitTaskRuntimeEvent({
      kind: 'task_completed', taskId: 'task-summary', chatId: -100, segment: 1, turn: 2,
      assessmentStatus: 'verified', resultSummary: 'private result text', resolution: 'private resolution text',
      cognitiveAnchorEventId: 'telegram-2', at: 1_700_000_002_000,
    });
    db.prepare(
      `INSERT INTO task_evidence
       (task_id, chat_id, lifecycle, assessment, turns, total_calls, failed_calls, retry_count, reasons, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('task-summary', -100, 'done', 'verified', 2, 3, 0, 1, JSON.stringify(['caller_checks_passed']), 1_700_000_002);

    const summary = getTaskRecoverySummary('task-summary', -100);
    expect(summary).toMatchObject({
      taskId: 'task-summary', chatId: -100, lifecycle: 'done', terminal: true,
      assessment: 'verified', verified: true, recoveryReason: 'completed_verified',
      checkpointAvailable: true, eventCount: 7, lastEventKind: 'task_completed',
      lastSegment: 1, lastTurn: 2, segments: 2, modelTurnsStarted: 1,
      modelTurnsFinished: 1, reasons: ['caller_checks_passed'], totalCalls: 3,
      failedCalls: 0, retryCount: 1, stateConflict: false,
    });
    expect(summary).not.toHaveProperty('resultSummary');
    expect(summary).not.toHaveProperty('resolution');
  });

  it('distinguishes waiting-user recovery from verified completion', () => {
    emitTaskRuntimeEvent({ kind: 'task_started', taskId: 'task-wait', chatId: -100, segment: 0, at: 1_700_000_010_000 });
    emitTaskRuntimeEvent({ kind: 'checkpoint_saved', taskId: 'task-wait', chatId: -100, segment: 1, turn: 5, at: 1_700_000_011_000 });
    emitTaskRuntimeEvent({ kind: 'task_waiting_user', taskId: 'task-wait', chatId: -100, segment: 1, turn: 5, at: 1_700_000_011_100 });
    db.prepare(
      `INSERT INTO task_evidence
       (task_id, chat_id, lifecycle, assessment, turns, total_calls, failed_calls, retry_count, reasons, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('task-wait', -100, 'waiting_user', 'unverified', 5, 2, 1, 1, JSON.stringify(['needs_clarification']), 1_700_000_011);

    expect(getTaskRecoverySummary('task-wait')).toMatchObject({
      lifecycle: 'waiting_user', terminal: false, assessment: 'unverified', verified: false,
      recoveryReason: 'waiting_user', checkpointAvailable: true, lastSegment: 1, lastTurn: 5,
      reasons: ['needs_clarification'], stateConflict: false,
    });
  });

  it('fails closed when one task id has events from multiple chats', () => {
    emitTaskRuntimeEvent({ kind: 'task_started', taskId: 'task-collision', chatId: -100, turn: 1, at: 1_700_000_020_000 });
    emitTaskRuntimeEvent({ kind: 'task_started', taskId: 'task-collision', chatId: -200, turn: 2, at: 1_700_000_020_100 });
    expect(getTaskRecoverySummary('task-collision')).toBeNull();
    expect(getTaskRecoverySummary('task-collision', -100)).toBeNull();
  });
});
