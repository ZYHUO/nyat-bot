import { EventEmitter } from 'node:events';

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
  | 'task_completed'
  | 'task_failed';

export interface TaskRuntimeEvent {
  kind: TaskRuntimeEventKind;
  taskId: string;
  chatId: number;
  at: number;
  turn?: number;
  segment?: number;
  toolName?: string;
  deliveryKind?: string;
  messageId?: number;
  errorCode?: string;
}

export const taskRuntimeEvents = new EventEmitter();
taskRuntimeEvents.setMaxListeners(100);

/** Emit non-content lifecycle facts; telemetry must never break task execution. */
export function emitTaskRuntimeEvent(event: Omit<TaskRuntimeEvent, 'at'> & { at?: number }): void {
  try {
    taskRuntimeEvents.emit('event', { ...event, at: event.at ?? Date.now() } satisfies TaskRuntimeEvent);
  } catch {
    /* telemetry is never part of the task critical path */
  }
}

export function onTaskRuntimeEvent(listener: (event: TaskRuntimeEvent) => void): () => void {
  taskRuntimeEvents.on('event', listener);
  return () => taskRuntimeEvents.off('event', listener);
}

export function resetTaskRuntimeEvents(): void {
  taskRuntimeEvents.removeAllListeners('event');
}
