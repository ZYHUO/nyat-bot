import { beforeEach, describe, expect, it, vi } from 'vitest';
const waitState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ getChatState: waitState }));
vi.mock('../../../src/shared/privacy-scope.js', () => ({ resolveConversationScope: () => ({
  chatId: -100, accountId: '123', platform: 'telegram', conversationKind: 'group',
}) }));

const {
  queueAddMock,
  emitTaskRuntimeEventMock,
  putTaskMock,
  persistTaskMock,
  enqueueLocalMock,
} = vi.hoisted(() => ({
  queueAddMock: vi.fn(async () => ({ id: 'job-1' })),
  emitTaskRuntimeEventMock: vi.fn(),
  putTaskMock: vi.fn(),
  persistTaskMock: vi.fn(async () => true),
  enqueueLocalMock: vi.fn(),
}));

vi.mock('bullmq', () => {
  class FakeQueue {
    add(...args: unknown[]) { return queueAddMock(...args); }
    close() { return Promise.resolve(); }
  }
  class FakeWorker {
    on() { return this; }
    close() { return Promise.resolve(); }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, DelayedError: class extends Error {} };
});
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_CONCURRENCY: 1,
  META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true,
  META_SUBAGENT_CHAT_IDS: [-100], META_ACTIVATED_AT_SEC: 1,
}) }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ putTask: putTaskMock }) }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  tryMarkCodeActActive: vi.fn(),
  clearCodeActActive: vi.fn(),
  persistCodeActTask: (...args: unknown[]) => persistTaskMock(...args),
}));
vi.mock('../../../src/subagent/executor.js', () => ({
  enqueueSubagentTaskLocal: (...args: unknown[]) => enqueueLocalMock(...args),
}));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({
  emitTaskRuntimeEvent: (...args: unknown[]) => emitTaskRuntimeEventMock(...args),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { enqueueCodeActJob, enqueueResumeCodeActJob } from '../../../src/subagent/queue.js';

beforeEach(() => {
  waitState.mockResolvedValue({ state: 'RUNNING', waitGeneration: 'current' });
  queueAddMock.mockClear();
  emitTaskRuntimeEventMock.mockClear();
  putTaskMock.mockClear();
  persistTaskMock.mockClear();
  enqueueLocalMock.mockClear();
});

describe('CodeAct queue durable lifecycle events', () => {
  it('rejects a stale WAIT task before normal or resumed admission without local fallback', async () => {
    const task = { id: 'wait', chatId: -100, contentDirection: 'bounded recovery', createdAt: Date.now(), status: 'queued' as const,
      waitRecovery: { generation: 'old', threadId: 0, chatId: -100, accountId: '123', platform: 'telegram' as const } };
    await expect(enqueueCodeActJob(task)).rejects.toThrow('wait_recovery_stale');
    await expect(enqueueResumeCodeActJob(task)).rejects.toThrow('wait_recovery_stale');
    expect(queueAddMock).not.toHaveBeenCalled(); expect(enqueueLocalMock).not.toHaveBeenCalled(); expect(putTaskMock).not.toHaveBeenCalled();
  });
  it('records task_queued only after normal queue acceptance', async () => {
    const task = {
      id: 'task-queued-1',
      chatId: -100,
      contentDirection: '做一次核验',
      createdAt: Date.now(),
      status: 'queued' as const,
    };

    await enqueueCodeActJob(task);

    expect(queueAddMock).toHaveBeenCalledWith('codeact', task, { jobId: 'codeact-task-queued-1' });
    expect(emitTaskRuntimeEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task_queued',
      taskId: 'task-queued-1',
      chatId: -100,
    }));
  });

  it('records task_queued for a resumed segment after fallback acceptance', async () => {
    queueAddMock.mockRejectedValueOnce(new Error('redis unavailable'));
    const task = {
      id: 'task-resume-1',
      chatId: -100,
      contentDirection: '续跑核验',
      createdAt: Date.now(),
      status: 'running' as const,
      segment: 2,
    };

    await enqueueResumeCodeActJob(task);

    expect(emitTaskRuntimeEventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'task_queued',
      taskId: 'task-resume-1',
      chatId: -100,
      segment: 2,
    }));
  });
});
