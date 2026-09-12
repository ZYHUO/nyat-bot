import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export type TaskProgressPhase =
  | 'queued'
  | 'started'
  | 'searching'
  | 'checking'
  | 'working'
  | 'synthesizing'
  | 'writing'
  | 'checkpoint'
  | 'waiting'
  | 'failed'
  | 'done';

export interface TaskProgressEvent {
  taskId: string | number;
  chatId: number;
  phase: TaskProgressPhase;
  text: string;
  replyToId?: number;
  messageThreadId?: number;
  segment?: number;
  /** Internal/self-play tasks should never produce user-visible progress. */
  visible?: boolean;
  /** Bypass phase de-duplication, still respecting the time/rate budget. */
  force?: boolean;
}

interface ProgressMemory {
  lastAutomaticAt: number;
  lastModelAt: number;
  sentCount: number;
  lastPhase?: TaskProgressPhase;
}

const memory = new Map<string, ProgressMemory>();
const MODEL_SUPPRESSION_MS = 15_000;

function taskKey(taskId: string | number): string {
  return String(taskId);
}

function phaseKey(event: TaskProgressEvent, bucket: number): string {
  return `xxb:agent:progress:${taskKey(event.taskId)}:${event.phase}:${event.segment ?? 0}:${bucket}`;
}

function getMemory(taskId: string | number): ProgressMemory {
  const key = taskKey(taskId);
  const existing = memory.get(key);
  if (existing) return existing;
  const created: ProgressMemory = { lastAutomaticAt: 0, lastModelAt: 0, sentCount: 0 };
  memory.set(key, created);
  return created;
}

/** Record that the task has produced a real model-visible message. */
export function markTaskVisible(taskId: string | number): void {
  getMemory(taskId).lastModelAt = Date.now();
}

/** Test/process cleanup hook; production code never needs to call this. */
export function resetTaskProgressMemory(): void {
  memory.clear();
}

/**
 * Send a short, deterministic task update without ever affecting task execution.
 * Redis provides cross-worker de-duplication; the in-process memory also prevents
 * a model reply and an automatic update from appearing back-to-back.
 */
export async function notifyTaskProgress(event: TaskProgressEvent): Promise<void> {
  const e = env();
  if (!e.TASK_PROGRESS_ENABLED || event.visible === false) return;
  if (!event.text.trim() || event.chatId === 0) return;

  const terminal = event.phase === 'done' || event.phase === 'failed';
  const now = Date.now();
  const state = getMemory(event.taskId);
  const minInterval = Math.max(
    0,
    Number(e.TASK_PROGRESS_KEEPALIVE_MS ?? e.TASK_PROGRESS_MIN_INTERVAL_MS ?? 30_000),
  );
  const maxUpdates = Math.max(1, Number(e.TASK_PROGRESS_MAX_VISIBLE_UPDATES ?? 6));

  if (!terminal && now - state.lastModelAt < MODEL_SUPPRESSION_MS) return;
  // A new semantic phase may be shown immediately; repeats in the same phase
  // are rate-limited to keep a long-running task from spamming the chat.
  if (!terminal && !event.force && state.lastPhase === event.phase && now - state.lastAutomaticAt < minInterval) return;
  if (!terminal && state.sentCount >= maxUpdates) return;

  try {
    const { getRedis } = await import('../db/redis.js');
    const redis = getRedis();
    const phaseBucket = Math.floor(now / Math.max(minInterval, 1_000));
    const phaseClaim = await redis.set(phaseKey(event, phaseBucket), '1', 'EX', 24 * 3600, 'NX');
    if (phaseClaim === null) return;

    const { sendMessage } = await import('../bot/sender/telegram.js');
    await sendMessage(event.chatId, event.text.trim().slice(0, 160), event.replyToId, event.messageThreadId);
    state.lastAutomaticAt = now;
    state.sentCount += 1;
    state.lastPhase = event.phase;
  } catch (err) {
    logger.debug({ err, taskId: event.taskId, phase: event.phase }, 'task progress notification failed');
  }
}
