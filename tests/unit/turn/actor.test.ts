import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PendingEntry } from '../../../src/pipeline/turn/types.js';

const envState = {
  TURN_ACTOR_ENABLED: true,
  TURN_ACTOR_CHAT_IDS: [] as number[],
  TIMING_GATE_ENABLED: false,
};

const { processPipelineMock, scheduleTurnMock, transitionToRunningMock } = vi.hoisted(() => ({
  processPipelineMock: vi.fn(async () => {}),
  scheduleTurnMock: vi.fn(async () => {}),
  transitionToRunningMock: vi.fn(async () => {}),
}));

const bufferState: {
  pending: PendingEntry[];
  dirty: boolean;
  epoch: number;
  clearedJobs: string[];
  postDrainPendingCount: number;
} = { pending: [], dirty: false, epoch: 0, clearedJobs: [], postDrainPendingCount: 0 };

let chatState: { state: 'RUNNING' | 'WAIT' | 'STOP' } = { state: 'RUNNING' };

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/pipeline/pipeline.js', () => ({ processPipeline: processPipelineMock }));
vi.mock('../../../src/queue/turn-scheduler.js', () => ({ scheduleTurn: scheduleTurnMock }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  getChatState: vi.fn(async () => chatState),
  transitionToRunning: transitionToRunningMock,
}));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({
  drainPending: vi.fn(async () => {
    const out = bufferState.pending;
    bufferState.pending = [];
    return out;
  }),
  pendingCount: vi.fn(async () => bufferState.postDrainPendingCount),
  clearScheduledJob: vi.fn(async (_chatId: number, jobId?: string) => {
    if (jobId) bufferState.clearedJobs.push(jobId);
  }),
  clearDirty: vi.fn(async () => {
    const was = bufferState.dirty;
    bufferState.dirty = false;
    return was;
  }),
  bumpEpoch: vi.fn(async () => ++bufferState.epoch),
}));

import { runChatTurn, isTurnActorChat } from '../../../src/pipeline/turn/actor.js';

const CHAT = -100800;

function entry(messageId: number, direct = false): PendingEntry {
  return {
    update: { update_id: messageId } as never,
    chatId: CHAT,
    messageId,
    enqueuedAt: Date.now(),
    direct,
  };
}

function turnJob(trigger: 'message' | 'direct' = 'message') {
  return {
    type: 'chat_turn' as const,
    chatId: CHAT,
    enqueuedAt: Date.now(),
    update: {} as never,
    turn: { trigger, scheduledAt: Date.now(), directPriority: trigger === 'direct' },
  };
}

beforeEach(() => {
  processPipelineMock.mockClear();
  scheduleTurnMock.mockClear();
  transitionToRunningMock.mockClear();
  bufferState.pending = [];
  bufferState.dirty = false;
  bufferState.epoch = 0;
  bufferState.clearedJobs = [];
  bufferState.postDrainPendingCount = 0;
  chatState = { state: 'RUNNING' };
  envState.TURN_ACTOR_ENABLED = true;
  envState.TURN_ACTOR_CHAT_IDS = [];
  envState.TIMING_GATE_ENABLED = false;
});

describe('isTurnActorChat', () => {
  it('respects the global flag and graylist', () => {
    expect(isTurnActorChat(CHAT)).toBe(true);
    envState.TURN_ACTOR_CHAT_IDS = [-1];
    expect(isTurnActorChat(CHAT)).toBe(false);
    envState.TURN_ACTOR_CHAT_IDS = [CHAT];
    expect(isTurnActorChat(CHAT)).toBe(true);
    envState.TURN_ACTOR_ENABLED = false;
    expect(isTurnActorChat(CHAT)).toBe(false);
  });
});

describe('runChatTurn', () => {
  it('exits quietly on an empty buffer (raced duplicate turn)', async () => {
    await runChatTurn(turnJob(), 'turn-1');
    expect(processPipelineMock).not.toHaveBeenCalled();
    expect(bufferState.clearedJobs).toEqual(['turn-1']);
  });

  it('judges only the final entry of a passive burst; earlier ones are tracking-only', async () => {
    bufferState.pending = [entry(1), entry(2), entry(3)];
    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(3);
    const flags = processPipelineMock.mock.calls.map((c) => (c[0] as { coalesce: { isLastInBatch: boolean } }).coalesce.isLastInBatch);
    expect(flags).toEqual([false, false, true]);
    const batchSizes = processPipelineMock.mock.calls.map((c) => (c[0] as { coalesce: { batchSize: number } }).coalesce.batchSize);
    expect(batchSizes).toEqual([3, 3, 3]);
  });

  it('judges every direct entry in a mixed burst', async () => {
    bufferState.pending = [entry(1), entry(2, true), entry(3)];
    await runChatTurn(turnJob('direct'), 'turn-1');

    const flags = processPipelineMock.mock.calls.map((c) => (c[0] as { coalesce: { isLastInBatch: boolean } }).coalesce.isLastInBatch);
    expect(flags).toEqual([false, true, true]);
  });

  it('suppresses a passive burst while WAIT (tracking-only, skipReply)', async () => {
    envState.TIMING_GATE_ENABLED = true;
    chatState = { state: 'WAIT' };
    bufferState.pending = [entry(1), entry(2)];

    await runChatTurn(turnJob(), 'turn-1');

    expect(transitionToRunningMock).not.toHaveBeenCalled();
    for (const call of processPipelineMock.mock.calls) {
      const job = call[0] as { skipReply?: boolean; coalesce: { isLastInBatch: boolean } };
      expect(job.skipReply).toBe(true);
      expect(job.coalesce.isLastInBatch).toBe(false);
    }
  });

  it('a direct entry wakes a WAIT chat and is judged', async () => {
    envState.TIMING_GATE_ENABLED = true;
    chatState = { state: 'WAIT' };
    bufferState.pending = [entry(1), entry(2, true)];

    await runChatTurn(turnJob('direct'), 'turn-1');

    expect(transitionToRunningMock).toHaveBeenCalledTimes(1);
    const last = processPipelineMock.mock.calls.at(-1)![0] as { skipReply?: boolean; coalesce: { isLastInBatch: boolean } };
    expect(last.skipReply).toBeUndefined();
    expect(last.coalesce.isLastInBatch).toBe(true);
  });

  it('reschedules itself when messages landed mid-turn (dirty flag)', async () => {
    bufferState.pending = [entry(1)];
    bufferState.dirty = true;
    await runChatTurn(turnJob(), 'turn-1');
    expect(scheduleTurnMock).toHaveBeenCalledWith(CHAT, { trigger: 'message' });
  });

  it('reschedules itself when pending refilled after drain', async () => {
    bufferState.pending = [entry(1)];
    bufferState.postDrainPendingCount = 2;
    await runChatTurn(turnJob(), 'turn-1');
    expect(scheduleTurnMock).toHaveBeenCalledTimes(1);
  });

  it('does not reschedule when the buffer stayed clean', async () => {
    bufferState.pending = [entry(1)];
    await runChatTurn(turnJob(), 'turn-1');
    expect(scheduleTurnMock).not.toHaveBeenCalled();
  });

  it('one failing entry does not kill the rest of the burst', async () => {
    bufferState.pending = [entry(1), entry(2), entry(3)];
    processPipelineMock.mockRejectedValueOnce(new Error('boom'));
    await runChatTurn(turnJob(), 'turn-1');
    expect(processPipelineMock).toHaveBeenCalledTimes(3);
  });
});
