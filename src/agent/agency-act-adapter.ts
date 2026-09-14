// Explicit Agency act/CodeAct adapter. The host owns task creation and queue
// submission; constructing this factory never starts a task by itself.

import { validateAgencyAction } from './agency.js';
import type { AgencyAction } from './agency.js';
import type { AgencyAdapter, AgencyAdapters, AgencyAdapterContext } from './agency-runtime.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';
import type { DispatchTask } from '../meta/types.js';

export interface AgencyActRequest {
  chatId: number;
  scope: CognitiveScope;
  goal: string;
  requestedTaskId?: string;
  runId: string;
  attempt: number;
  correlationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface AgencyActResult {
  /** Durable task id returned by the host task store. */
  taskId: string;
  /** Epoch milliseconds at which the host accepted the task. */
  acceptedAt: number;
  /** Optional queue/job id exposed by the host scheduler. */
  queueJobId?: string;
}

/** The host owns CodeAct task persistence, queueing and any task authority. */
export type AgencyAct = (request: AgencyActRequest) => Promise<AgencyActResult>;

function scopedChatId(context: AgencyAdapterContext): number {
  const chatId = context.scope.chatId;
  if (context.scope.visibility === 'global' || chatId === undefined || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error('act requires a scoped chat');
  }
  return chatId;
}

function checkedAction(action: AgencyAction): Extract<AgencyAction, { type: 'act' }> {
  const checked = validateAgencyAction(action);
  if (!checked.ok || !checked.action || checked.action.type !== 'act') {
    throw new Error('act adapter action mismatch');
  }
  return checked.action;
}

function checkedOptionalTaskId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const taskId = value.trim();
  if (!taskId || taskId.length > 240) throw new Error('invalid requested task id');
  return taskId;
}

function checkedResult(result: AgencyActResult): AgencyActResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.taskId !== 'string' || !result.taskId.trim() || result.taskId.length > 240
    || !Number.isSafeInteger(result.acceptedAt) || result.acceptedAt <= 0) {
    throw new Error('invalid act receipt');
  }
  if (result.queueJobId !== undefined
    && (typeof result.queueJobId !== 'string' || !result.queueJobId.trim() || result.queueJobId.length > 240)) {
    throw new Error('invalid act queue job id');
  }
  return {
    taskId: result.taskId.trim(),
    acceptedAt: result.acceptedAt,
    ...(result.queueJobId !== undefined ? { queueJobId: result.queueJobId.trim() } : {}),
  };
}

function actAdapter(start: AgencyAct): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction);
    const chatId = scopedChatId(context);
    if (context.signal.aborted) throw new Error('agency run cancelled');

    context.usage.consumeToolCall();
    const result = await start({
      chatId,
      scope: context.scope,
      goal: action.goal,
      ...(action.taskId !== undefined ? { requestedTaskId: checkedOptionalTaskId(action.taskId) } : {}),
      runId: context.runId,
      attempt: context.attempt,
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
    });
    return checkedResult(result);
  };
}

/** Build an explicit CodeAct task adapter for a caller-owned task host. */
export function createAgencyActAdapters(start: AgencyAct): Pick<AgencyAdapters, 'act'> {
  return { act: actAdapter(start) };
}

/**
 * Bind the generic contract to the existing CodeAct queue. The import is
 * delayed until dispatch so merely importing or constructing the binding does
 * not connect Redis or enqueue work.
 */
export function createCodeActAgencyActAdapters(template?: DispatchTask): Pick<AgencyAdapters, 'act'> {
  return createAgencyActAdapters(async ({ chatId, goal, requestedTaskId, runId }) => {
    const { enqueueCodeActJob } = await import('../subagent/queue.js');
    const taskId = requestedTaskId ?? template?.id ?? `agency-act-${runId}`;
    // When the main pipeline hands us a template, preserve quote/target/
    // acceptance/checkpoint metadata. The generic factory still supports a
    // minimal task for callers that only have a goal and chat scope.
    const task: DispatchTask = template
      ? {
        ...template,
        id: taskId,
        chatId,
        contentDirection: goal,
        status: 'queued',
      }
      : {
        id: taskId,
        chatId,
        contentDirection: goal,
        createdAt: Date.now(),
        status: 'queued',
      };
    await enqueueCodeActJob(task);
    return { taskId, acceptedAt: Date.now() };
  });
}
