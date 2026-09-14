import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';
import { projectCognitiveEvent } from '../../../src/agent/cognitive-projector.js';
import { recordPrediction } from '../../../src/agent/predictions.js';
import { createDebt } from '../../../src/agent/cognitive-debts.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0087_cognitive_debts.sql', 'utf8'));
  db.exec(readFileSync('migrations/0088_bot_predictions.sql', 'utf8'));
  db.exec(readFileSync('migrations/0089_cognitive_events.sql', 'utf8'));
  db.exec(readFileSync('migrations/0091_cognitive_outbox.sql', 'utf8'));
  db.exec(readFileSync('migrations/0093_scope_columns.sql', 'utf8'));
  db.exec(readFileSync('migrations/0094_debt_resolution_provenance.sql', 'utf8'));
});

describe('cognitive event projector', () => {
  it('creates one sourced debt and remains idempotent on replay', () => {
    const appended = appendCognitiveEvent({
      type: 'user_correction',
      source: 'telegram',
      scope: { visibility: 'chat', chatId: -100, userId: 42 },
      correlationId: 'feedback-1',
      fact: { messageId: 9, reason: '事实纠正' },
    });
    const event = appended!.event;
    expect(projectCognitiveEvent(event).debtsCreated).toBe(1);
    expect(projectCognitiveEvent(event).debtsCreated).toBe(0);
    const row = db.prepare('SELECT kind, chat_id, source_event_ids FROM cognitive_debts').get() as {
      kind: string; chat_id: number; source_event_ids: string;
    };
    expect(row.kind).toBe('correction');
    expect(row.chat_id).toBe(-100);
    expect(JSON.parse(row.source_event_ids)).toEqual([event.id]);
  });

  it('resolves a prediction from host-observable feedback', () => {
    recordPrediction({ chatId: -100, messageId: 7, predictedSentiment: 0.5 });
    const appended = appendCognitiveEvent({
      type: 'user_reaction',
      source: 'telegram',
      scope: { visibility: 'chat', chatId: -100, userId: 42 },
      correlationId: 'feedback-2',
      fact: { botMessageId: 7, sentiment: -0.6, feedbackKind: 'reaction' },
    });
    const result = projectCognitiveEvent(appended!.event, { createDebts: false });
    expect(result.predictionFeedbackSeen).toBe(true);
    const row = db.prepare('SELECT actual_sentiment, prediction_error, outcome_event_id FROM bot_predictions WHERE message_id = 7').get() as {
      actual_sentiment: number; prediction_error: number; outcome_event_id?: string;
    };
    expect(row.actual_sentiment).toBeCloseTo(-0.6);
    expect(row.prediction_error).toBeCloseTo(-0.6);
    expect(row.outcome_event_id).toBe(appended!.event.id);
  });

  it('repays task debts only from a completed task event with matching scope', () => {
    const debtId = createDebt({
      chatId: -100,
      taskId: 'task-1',
      kind: 'unfinished_task',
      statement: '任务仍在等待验收',
      sourceEventIds: ['task-start'],
    });
    const otherDebtId = createDebt({
      chatId: -100,
      taskId: 'task-2',
      kind: 'unfinished_task',
      statement: '另一个任务仍在等待验收',
      sourceEventIds: ['task-start-2'],
    });
    expect(debtId).not.toBeNull();
    expect(otherDebtId).not.toBeNull();

    const completed = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'task', chatId: -100, taskId: 'task-1' },
      correlationId: 'task:task-1',
      fact: { kind: 'task_completed', assessmentStatus: 'verified', resolution: 'host acceptance passed' },
    });
    const result = projectCognitiveEvent(completed!.event, { createDebts: false });
    expect(result.debtsResolved).toBe(1);
    const rows = db.prepare('SELECT id, status, resolution_event_id FROM cognitive_debts ORDER BY id').all() as Array<{
      id: number; status: string; resolution_event_id: string | null;
    }>;
    expect(rows).toEqual([
      { id: debtId, status: 'resolved', resolution_event_id: completed!.event.id },
      { id: otherDebtId, status: 'open', resolution_event_id: null },
    ]);
  });

  it('keeps task debts open when lifecycle is done without verified acceptance', () => {
    const debtId = createDebt({
      chatId: -100,
      taskId: 'unverified-task',
      kind: 'unfinished_task',
      statement: '任务完成声明尚未验收',
      sourceEventIds: ['task-start-unverified'],
    });
    const completed = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'task', chatId: -100, taskId: 'unverified-task' },
      correlationId: 'task:unverified-task',
      fact: { kind: 'task_completed', assessmentStatus: 'unverified', resolution: '模型声称完成' },
    });
    expect(projectCognitiveEvent(completed!.event, { createDebts: false }).debtsResolved).toBe(0);
    expect(db.prepare('SELECT status, resolution_event_id FROM cognitive_debts WHERE id = ?').get(debtId)).toEqual({
      status: 'open', resolution_event_id: null,
    });
  });

  it('rejects explicit debt resolution from a different task scope', () => {
    const debtId = createDebt({
      chatId: -100,
      taskId: 'task-2',
      kind: 'correction',
      statement: '任务二需要复核',
      sourceEventIds: ['correction-2'],
    });
    const event = appendCognitiveEvent({
      type: 'task_observation',
      source: 'host',
      scope: { visibility: 'task', chatId: -100, taskId: 'task-1' },
      correlationId: 'task:task-1',
      fact: { debtId, resolution: '不应跨任务关闭' },
    });
    const result = projectCognitiveEvent(event!.event, { createDebts: false });
    expect(result.debtsResolved).toBe(0);
    expect(db.prepare('SELECT status FROM cognitive_debts WHERE id = ?').get(debtId)).toEqual({ status: 'open' });
  });

  it('records user-stop resolution evidence for the matching task only', () => {
    const debtId = createDebt({
      chatId: -100,
      taskId: 'task-3',
      kind: 'unfinished_task',
      statement: '任务三等待用户决定',
      sourceEventIds: ['task-start-3'],
    });
    const stop = appendCognitiveEvent({
      type: 'user_stop',
      source: 'telegram',
      scope: { visibility: 'task', chatId: -100, taskId: 'task-3' },
      correlationId: 'task:task-3',
      fact: { resolution: '用户确认停止，任务关闭' },
    });
    const result = projectCognitiveEvent(stop!.event, { createDebts: false });
    expect(result.debtsResolved).toBe(1);
    expect(db.prepare('SELECT status, resolution_event_id FROM cognitive_debts WHERE id = ?').get(debtId)).toEqual({
      status: 'resolved',
      resolution_event_id: stop!.event.id,
    });
  });

  it('does not reopen a debt for a task explicitly stopped by the user', () => {
    const stopped = appendCognitiveEvent({
      type: 'tool_failure',
      source: 'host',
      scope: { visibility: 'task', chatId: -100, taskId: 'task-stopped' },
      correlationId: 'task:task-stopped',
      fact: { kind: 'task_failed', resultSummary: 'failed_user_stopped' },
    });
    const result = projectCognitiveEvent(stopped!.event);
    expect(result.debtsCreated).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM cognitive_debts').get()).toEqual({ count: 0 });
  });

  it('resolves only the matching tool failure after a later successful callback', () => {
    const failed = appendCognitiveEvent({
      type: 'tool_failure',
      source: 'tool',
      scope: { visibility: 'task', chatId: -100, taskId: 'tool-retry-1' },
      correlationId: 'task:tool-retry-1',
      fact: { kind: 'tool_finished', toolName: 'web.search', invocationId: 'call-1', errorCode: 'timeout' },
    })!.event;
    expect(projectCognitiveEvent(failed).debtsCreated).toBe(1);
    const succeeded = appendCognitiveEvent({
      type: 'task_observation',
      source: 'tool',
      scope: { visibility: 'task', chatId: -100, taskId: 'tool-retry-1' },
      correlationId: 'task:tool-retry-1',
      fact: { kind: 'tool_finished', toolName: 'web.search', invocationId: 'call-2' },
    })!.event;
    expect(projectCognitiveEvent(succeeded, { createDebts: false }).toolCallbackProjected).toBe(1);
    expect(db.prepare('SELECT status, resolution_event_id FROM cognitive_debts').get()).toEqual({
      status: 'resolved', resolution_event_id: succeeded.id,
    });
    expect(projectCognitiveEvent(succeeded, { createDebts: false }).toolCallbackProjected).toBe(0);
  });

  it('does not resolve a failure from another task or a different tool', () => {
    const failed = appendCognitiveEvent({
      type: 'tool_failure', source: 'tool',
      scope: { visibility: 'task', chatId: -100, taskId: 'tool-retry-a' },
      correlationId: 'task:tool-retry-a',
      fact: { kind: 'tool_finished', toolName: 'web.fetch', invocationId: 'call-a', errorCode: 'timeout' },
    })!.event;
    projectCognitiveEvent(failed);
    const succeeded = appendCognitiveEvent({
      type: 'task_observation', source: 'tool',
      scope: { visibility: 'task', chatId: -100, taskId: 'tool-retry-b' },
      correlationId: 'task:tool-retry-b',
      fact: { kind: 'tool_finished', toolName: 'web.search', invocationId: 'call-b' },
    })!.event;
    expect(projectCognitiveEvent(succeeded, { createDebts: false }).toolCallbackProjected).toBe(0);
    expect(db.prepare('SELECT status FROM cognitive_debts').get()).toEqual({ status: 'open' });
  });

  it('does not let model-authored feedback or resolution facts change host state', () => {
    recordPrediction({ chatId: -100, messageId: 99, predictedSentiment: 0.5 });
    const feedback = appendCognitiveEvent({
      type: 'user_reaction',
      source: 'model',
      scope: { visibility: 'chat', chatId: -100 },
      correlationId: 'spoof-feedback',
      fact: { botMessageId: 99, sentiment: 1, feedbackKind: 'reaction' },
    })!.event;
    expect(projectCognitiveEvent(feedback, { createDebts: false })).toMatchObject({ predictionFeedbackSeen: false, ignored: true });
    expect(db.prepare('SELECT actual_sentiment FROM bot_predictions WHERE message_id = 99').get()).toEqual({ actual_sentiment: null });

    const debtId = createDebt({
      chatId: -100,
      taskId: 'model-task',
      kind: 'uncertainty',
      statement: '模型不能自行关闭',
      sourceEventIds: ['source'],
    });
    const resolution = appendCognitiveEvent({
      type: 'task_observation',
      source: 'model',
      scope: { visibility: 'task', chatId: -100, taskId: 'model-task' },
      correlationId: 'spoof-resolution',
      fact: { debtId, resolution: '模型声称完成' },
    })!.event;
    expect(projectCognitiveEvent(resolution, { createDebts: false })).toMatchObject({ debtsResolved: 0, ignored: true });
    expect(db.prepare('SELECT status FROM cognitive_debts WHERE id = ?').get(debtId)).toEqual({ status: 'open' });
  });
});
