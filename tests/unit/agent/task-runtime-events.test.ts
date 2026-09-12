import { describe, expect, it, vi } from 'vitest';
import { emitTaskRuntimeEvent, onTaskRuntimeEvent, resetTaskRuntimeEvents } from '../../../src/agent/task-runtime-events.js';

describe('task runtime events', () => {
  it('emits lifecycle metadata without message content', () => {
    const seen: unknown[] = [];
    const off = onTaskRuntimeEvent((event) => seen.push(event));
    emitTaskRuntimeEvent({ taskId: 't1', chatId: -100, kind: 'model_message_sent', deliveryKind: 'discovery', messageId: 9 });
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ taskId: 't1', chatId: -100, kind: 'model_message_sent', deliveryKind: 'discovery', messageId: 9 });
    expect(seen[0]).not.toHaveProperty('content');
  });

  it('isolates listener failures from task execution', () => {
    const bad = vi.fn(() => { throw new Error('observer failed'); });
    const off = onTaskRuntimeEvent(bad);
    expect(() => emitTaskRuntimeEvent({ taskId: 't2', chatId: -100, kind: 'task_started' })).not.toThrow();
    off();
    resetTaskRuntimeEvents();
  });
});
