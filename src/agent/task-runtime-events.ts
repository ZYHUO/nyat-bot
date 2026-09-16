import { EventEmitter } from 'node:events';
import { appendCognitiveEvent, listCognitiveEvents } from './cognitive-events.js';
import type { CognitiveEvent } from './cognitive-events.js';
import { getTaskEvidence } from './task-evidence-store.js';

export type TaskRuntimeEventKind =
  | 'task_queued'
  | 'task_started'
  | 'model_turn_started'
  | 'model_turn_finished'
  | 'tool_started'
  | 'tool_finished'
  | 'model_message_sent'
  | 'user_interrupt_received'
  | 'checkpoint_saved'
  | 'task_waiting_user'
  | 'user_clarification_received'
  | 'task_completed'
  | 'task_failed';

export interface TaskRuntimeEvent {
  kind: TaskRuntimeEventKind;
  taskId: string;
  chatId: number;
  at: number;
  /** Durable Telegram/cognitive event that caused this lifecycle fact. */
  cognitiveAnchorEventId?: string;
  /** Stable host invocation id shared by tool_started/tool_finished. */
  invocationId?: string;
  turn?: number;
  segment?: number;
  toolName?: string;
  deliveryKind?: string;
  messageId?: number;
  errorCode?: string;
  resultSummary?: string;
  resolution?: string;
  assessmentStatus?: string;
}

export interface TaskRuntimeReplayOptions {
  /** Correlation sequence to resume after; useful after a worker restart. */
  afterSequence?: number;
  /** Maximum durable events to inspect. */
  limit?: number;
}

export type TaskRecoveryLifecycle = 'unknown' | 'queued' | 'running' | 'waiting_user' | 'done' | 'failed';
export type TaskRecoveryReason =
  | 'no_events'
  | 'queued_or_running'
  | 'checkpoint_available'
  | 'waiting_user'
  | 'completed_verified'
  | 'completed_unverified'
  | 'acceptance_failed'
  | 'execution_failed'
  | 'user_stopped';

/**
 * Host-only replay summary. It intentionally contains no task direction,
 * model output, result summary, resolution text, tool arguments, or evidence
 * payloads; callers can use it to decide whether a task needs recovery.
 */
export interface TaskRecoverySummary {
  taskId: string;
  chatId: number;
  lifecycle: TaskRecoveryLifecycle;
  terminal: boolean;
  assessment: 'verified' | 'failed' | 'unverified' | 'unknown';
  verified: boolean;
  recoveryReason: TaskRecoveryReason;
  checkpointAvailable: boolean;
  eventCount: number;
  lastEventKind?: TaskRuntimeEventKind;
  lastEventAt?: number;
  lastSegment?: number;
  lastTurn?: number;
  segments: number;
  modelTurnsStarted: number;
  modelTurnsFinished: number;
  toolCallsStarted: number;
  toolCallsFinished: number;
  toolFailures: number;
  interruptions: number;
  clarifications: number;
  cognitiveAnchorEventId?: string;
  reasons: string[];
  totalCalls?: number;
  failedCalls?: number;
  retryCount?: number;
  evidenceUpdatedAt?: number;
  stateConflict: boolean;
}

export const taskRuntimeEvents = new EventEmitter();
taskRuntimeEvents.setMaxListeners(100);

function durableType(event: TaskRuntimeEvent): 'task_observation' | 'tool_failure' | 'bot_delivery' | 'user_stop' {
  if (event.kind === 'model_message_sent') return 'bot_delivery';
  if (event.kind === 'user_interrupt_received') return 'user_stop';
  if (event.kind === 'task_failed' || (event.kind === 'tool_finished' && event.errorCode)) return 'tool_failure';
  return 'task_observation';
}

function durableSource(event: TaskRuntimeEvent): 'telegram' | 'host' | 'tool' {
  if (event.kind === 'user_interrupt_received') return 'telegram';
  if (event.kind === 'tool_started' || event.kind === 'tool_finished') return 'tool';
  return 'host';
}

function persistRuntimeEvent(event: TaskRuntimeEvent): string | undefined {
  try {
    const normalizedAnchor = typeof event.cognitiveAnchorEventId === 'string'
      ? event.cognitiveAnchorEventId.trim()
      : '';
    const cognitiveAnchorEventId = normalizedAnchor.length > 0 && normalizedAnchor.length <= 240
      ? normalizedAnchor
      : undefined;
    const suffix = [event.kind, event.invocationId, event.turn, event.segment, event.toolName, event.messageId]
      .map((value) => value === undefined ? '' : String(value))
      .join(':');
    const result = appendCognitiveEvent({
      type: durableType(event),
      source: durableSource(event),
      scope: { visibility: 'task', taskId: event.taskId, chatId: event.chatId },
      occurredAt: Math.max(1, Math.floor(event.at / 1000)),
      ...(cognitiveAnchorEventId ? { causationId: cognitiveAnchorEventId } : {}),
      correlationId: `task:${event.taskId}`,
      dedupeKey: `task-runtime:${event.taskId}:${suffix}`,
      fact: {
        kind: event.kind,
        atMs: event.at,
        cognitiveAnchorEventId: cognitiveAnchorEventId ?? null,
        invocationId: event.invocationId ?? null,
        chatId: event.chatId,
        taskId: event.taskId,
        turn: event.turn ?? null,
        segment: event.segment ?? null,
        toolName: event.toolName ?? null,
        deliveryKind: event.deliveryKind ?? null,
        messageId: event.messageId ?? null,
        errorCode: event.errorCode ?? null,
        resultSummary: event.resultSummary?.slice(0, 240) ?? null,
        resolution: event.resolution?.slice(0, 400) ?? null,
        assessmentStatus: event.assessmentStatus?.slice(0, 80) ?? null,
      },
    });
    return result?.event.id;
  } catch {
    /* durable telemetry is best-effort and never blocks task execution */
  }
}

function factString(event: CognitiveEvent, key: string): string | undefined {
  const value = event.fact[key];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 400) : undefined;
}

function factNumber(event: CognitiveEvent, key: string): number | undefined {
  const value = event.fact[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function taskRuntimeEventFromCognitive(event: CognitiveEvent, taskId: string): TaskRuntimeEvent | undefined {
  if (event.visibility !== 'task' || event.taskId !== taskId) return undefined;
  const kind = factString(event, 'kind');
  if (!kind || !TASK_RUNTIME_EVENT_KINDS.has(kind)) return undefined;
  const chatId = event.chatId ?? factNumber(event, 'chatId');
  if (chatId === undefined || !Number.isSafeInteger(chatId) || chatId === 0) return undefined;
  const atMs = factNumber(event, 'atMs');
  return {
    kind: kind as TaskRuntimeEventKind,
    taskId,
    chatId,
    at: atMs !== undefined && atMs > 0 ? atMs : event.occurredAt * 1000,
    ...(event.causationId ? { cognitiveAnchorEventId: event.causationId } : {}),
    ...(factString(event, 'invocationId') ? { invocationId: factString(event, 'invocationId') } : {}),
    ...(factNumber(event, 'turn') !== undefined ? { turn: factNumber(event, 'turn') } : {}),
    ...(factNumber(event, 'segment') !== undefined ? { segment: factNumber(event, 'segment') } : {}),
    ...(factString(event, 'toolName') ? { toolName: factString(event, 'toolName') } : {}),
    ...(factString(event, 'deliveryKind') ? { deliveryKind: factString(event, 'deliveryKind') } : {}),
    ...(factNumber(event, 'messageId') !== undefined ? { messageId: factNumber(event, 'messageId') } : {}),
    ...(factString(event, 'errorCode') ? { errorCode: factString(event, 'errorCode') } : {}),
    ...(factString(event, 'resultSummary') ? { resultSummary: factString(event, 'resultSummary') } : {}),
    ...(factString(event, 'resolution') ? { resolution: factString(event, 'resolution') } : {}),
    ...(factString(event, 'assessmentStatus') ? { assessmentStatus: factString(event, 'assessmentStatus') } : {}),
  };
}

const TASK_RUNTIME_EVENT_KINDS: ReadonlySet<string> = new Set([
  'task_queued',
  'task_started',
  'model_turn_started',
  'model_turn_finished',
  'tool_started',
  'tool_finished',
  'model_message_sent',
  'user_interrupt_received',
  'checkpoint_saved',
  'task_waiting_user',
  'user_clarification_received',
  'task_completed',
  'task_failed',
]);

/** Emit non-content lifecycle facts; telemetry must never break task execution. */
export function emitTaskRuntimeEvent(event: Omit<TaskRuntimeEvent, 'at'> & { at?: number }): string | undefined {
  const normalized = { ...event, at: event.at ?? Date.now() } satisfies TaskRuntimeEvent;
  let eventId: string | undefined;
  try {
    eventId = persistRuntimeEvent(normalized);
  } catch {
    /* durable telemetry is never part of the task critical path */
  }
  try {
    taskRuntimeEvents.emit('event', normalized);
  } catch {
    /* listener failures are isolated from task execution */
  }
  return eventId;
}

export function onTaskRuntimeEvent(listener: (event: TaskRuntimeEvent) => void): () => void {
  taskRuntimeEvents.on('event', listener);
  return () => taskRuntimeEvents.off('event', listener);
}

/**
 * Rebuild task lifecycle metadata from the durable event log. This is read-only
 * and intentionally independent of the in-process EventEmitter, so a restarted
 * worker can resume/inspect a task without relying on lost process memory.
 */
export function listTaskRuntimeEvents(
  taskId: string,
  options: TaskRuntimeReplayOptions = {},
): TaskRuntimeEvent[] {
  const normalized = taskId.trim().slice(0, 120);
  if (!normalized) return [];
  const afterSequence = options.afterSequence === undefined
    ? undefined
    : Math.max(0, Math.trunc(options.afterSequence));
  const limit = options.limit === undefined
    ? 1000
    : Math.min(1000, Math.max(1, Math.trunc(options.limit)));
  return listCognitiveEvents({
    correlationId: `task:${normalized}`,
    afterSequence,
    limit,
  })
    .map((event) => taskRuntimeEventFromCognitive(event, normalized))
    .filter((event): event is TaskRuntimeEvent => event !== undefined);
}

function recoveryLifecycle(value: unknown): TaskRecoveryLifecycle {
  switch (value) {
    case 'queued':
    case 'running':
    case 'waiting_user':
    case 'done':
    case 'failed':
      return value;
    default:
      return 'unknown';
  }
}

function recoveryAssessment(value: unknown): TaskRecoverySummary['assessment'] {
  return value === 'verified' || value === 'failed' || value === 'unverified' ? value : 'unknown';
}

function safeReasonCodes(reasons: readonly string[]): string[] {
  const out: string[] = [];
  for (const reason of reasons) {
    const code = typeof reason === 'string' ? reason.trim().slice(0, 80) : '';
    if (!code) continue;
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(code)) out.push(code);
    else if (!out.includes('unstructured_reason')) out.push('unstructured_reason');
    if (out.length >= 8) break;
  }
  return out;
}

function terminalAssessment(events: readonly TaskRuntimeEvent[]): TaskRecoverySummary['assessment'] {
  const terminal = [...events].reverse().find((event) => event.kind === 'task_completed' || event.kind === 'task_failed');
  return recoveryAssessment(terminal?.assessmentStatus);
}

function hasUserStop(events: readonly TaskRuntimeEvent[]): boolean {
  return events.some((event) => event.kind === 'user_interrupt_received'
    && (event.resultSummary === 'failed_user_stopped' || event.resultSummary === 'user_stopped'))
    || events.some((event) => (event.kind === 'task_failed')
      && (event.resultSummary === 'failed_user_stopped' || event.resultSummary === 'user_stopped'));
}

/**
 * Reconstruct the durable task lifecycle and acceptance boundary after a
 * process restart. A task id must belong to exactly one chat; ambiguous
 * cross-chat telemetry is rejected rather than summarized.
 */
export function getTaskRecoverySummary(taskId: string, chatId?: number): TaskRecoverySummary | null {
  const normalizedTaskId = typeof taskId === 'string' ? taskId.trim().slice(0, 120) : '';
  if (!normalizedTaskId || normalizedTaskId.includes('\0')) return null;
  if (chatId !== undefined && (!Number.isSafeInteger(chatId) || chatId === 0)) return null;

  const events = listTaskRuntimeEvents(normalizedTaskId, { limit: 1000 });
  const chatIds = [...new Set(events.map((event) => event.chatId))];
  if (chatIds.length > 1 || (chatId !== undefined && chatIds.some((id) => id !== chatId))) return null;

  const evidence = getTaskEvidence(normalizedTaskId, chatId ?? chatIds[0]);
  if (chatId !== undefined && evidence && evidence.chatId !== chatId) return null;
  if (chatIds.length === 0 && !evidence) return null;
  const resolvedChatId = chatId ?? evidence?.chatId ?? chatIds[0];
  if (resolvedChatId === undefined || !Number.isSafeInteger(resolvedChatId) || resolvedChatId === 0) return null;

  let lifecycle: TaskRecoveryLifecycle = 'unknown';
  for (const event of events) {
    if (event.kind === 'task_queued') lifecycle = 'queued';
    else if (event.kind === 'task_started') lifecycle = 'running';
    else if (event.kind === 'task_waiting_user') lifecycle = 'waiting_user';
    else if (event.kind === 'task_completed') lifecycle = 'done';
    else if (event.kind === 'task_failed') lifecycle = 'failed';
  }
  const evidenceLifecycle = recoveryLifecycle(evidence?.lifecycle);
  const eventTerminal = lifecycle === 'done' || lifecycle === 'failed';
  const evidenceTerminal = evidenceLifecycle === 'done' || evidenceLifecycle === 'failed';
  const stateConflict = eventTerminal && evidenceTerminal && lifecycle !== evidenceLifecycle;
  if (!events.length && evidenceLifecycle !== 'unknown') lifecycle = evidenceLifecycle;
  else if (!eventTerminal && evidenceTerminal) lifecycle = evidenceLifecycle;

  const eventAssessment = terminalAssessment(events);
  const assessment = evidence ? recoveryAssessment(evidence.assessment) : eventAssessment;
  const terminal = lifecycle === 'done' || lifecycle === 'failed';
  const verified = terminal && lifecycle === 'done' && assessment === 'verified';
  const checkpointAvailable = events.some((event) => event.kind === 'checkpoint_saved');
  const maxSegment = events.reduce((max, event) => Math.max(max, event.segment ?? -1), -1);
  const maxTurn = events.reduce((max, event) => Math.max(max, event.turn ?? -1), -1);
  const last = events[events.length - 1];
  let recoveryReason: TaskRecoveryReason;
  if (!events.length && !evidence) recoveryReason = 'no_events';
  else if (lifecycle === 'waiting_user') recoveryReason = 'waiting_user';
  else if (lifecycle === 'queued' || lifecycle === 'running') {
    recoveryReason = checkpointAvailable ? 'checkpoint_available' : 'queued_or_running';
  } else if (lifecycle === 'done') {
    recoveryReason = assessment === 'verified' ? 'completed_verified' : assessment === 'failed' ? 'acceptance_failed' : 'completed_unverified';
  } else if (lifecycle === 'failed') {
    recoveryReason = hasUserStop(events) ? 'user_stopped' : assessment === 'failed' ? 'acceptance_failed' : 'execution_failed';
  } else {
    recoveryReason = 'no_events';
  }

  const evidenceReasons = safeReasonCodes(evidence?.reasons ?? []);
  if (!evidenceReasons.length && recoveryReason !== 'no_events') evidenceReasons.push(recoveryReason);
  return {
    taskId: normalizedTaskId,
    chatId: resolvedChatId,
    lifecycle,
    terminal,
    assessment,
    verified,
    recoveryReason,
    checkpointAvailable,
    eventCount: events.length,
    ...(last ? { lastEventKind: last.kind, lastEventAt: last.at } : {}),
    ...(maxSegment >= 0 ? { lastSegment: maxSegment } : {}),
    ...(maxTurn >= 0 ? { lastTurn: maxTurn } : {}),
    segments: maxSegment >= 0 ? maxSegment + 1 : 0,
    modelTurnsStarted: events.filter((event) => event.kind === 'model_turn_started').length,
    modelTurnsFinished: events.filter((event) => event.kind === 'model_turn_finished').length,
    toolCallsStarted: events.filter((event) => event.kind === 'tool_started').length,
    toolCallsFinished: events.filter((event) => event.kind === 'tool_finished').length,
    toolFailures: events.filter((event) => event.kind === 'tool_finished' && Boolean(event.errorCode)).length,
    interruptions: events.filter((event) => event.kind === 'user_interrupt_received').length,
    clarifications: events.filter((event) => event.kind === 'user_clarification_received').length,
    ...(last?.cognitiveAnchorEventId ? { cognitiveAnchorEventId: last.cognitiveAnchorEventId } : {}),
    reasons: evidenceReasons,
    ...(evidence ? {
      totalCalls: evidence.totalCalls,
      failedCalls: evidence.failedCalls,
      retryCount: evidence.retryCount,
      evidenceUpdatedAt: evidence.updatedAt,
    } : {}),
    stateConflict,
  };
}

/** Replay durable task lifecycle metadata in correlation sequence order. */
export async function replayTaskRuntimeEvents(
  taskId: string,
  handler: (event: TaskRuntimeEvent) => void | Promise<void>,
  options: TaskRuntimeReplayOptions = {},
): Promise<number> {
  const events = listTaskRuntimeEvents(taskId, options);
  for (const event of events) await handler(event);
  return events.length;
}

export function resetTaskRuntimeEvents(): void {
  taskRuntimeEvents.removeAllListeners('event');
}
