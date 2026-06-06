import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PendingEntry } from '../../../src/pipeline/turn/types.js';
import { AIError } from '../../../src/shared/errors.js';

const envState = {
  TURN_ACTOR_ENABLED: true,
  TURN_ACTOR_CHAT_IDS: [] as number[],
  TIMING_GATE_ENABLED: false,
  TURN_ABORT_ENABLED: false,
  TURN_INTERRUPT_MAX_CONSECUTIVE: 3,
  TURN_INTERRUPT_QUIET_MS: 0,
  TURN_MAX_INTERNAL_ROUNDS: 4,
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
  getLastMsgAt: vi.fn(async () => undefined),
}));

import { runChatTurn, isTurnActorChat } from '../../../src/pipeline/turn/actor.js';
import { _resetAbortRegistry } from '../../../src/pipeline/turn/abort-registry.js';

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
  envState.TURN_ABORT_ENABLED = false;
  _resetAbortRegistry();
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
    // scheduledJobId 保持指向本 job(运行期间新消息靠 active→markDirty 路径)
    expect(bufferState.clearedJobs).toEqual([]);
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

  it('mixed burst: exactly ONE judged anchor — the last direct entry', async () => {
    bufferState.pending = [entry(1), entry(2, true), entry(3)];
    await runChatTurn(turnJob('direct'), 'turn-1');

    const flags = processPipelineMock.mock.calls.map((c) => (c[0] as { coalesce: { isLastInBatch: boolean } }).coalesce.isLastInBatch);
    // 单锚点:direct(#2)被判,末尾闲聊(#3)只做 tracking(避免同回合双回复)
    expect(flags).toEqual([false, true, false]);
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

  it('reschedules itself when messages landed mid-turn (dirty flag) — forceNew', async () => {
    bufferState.pending = [entry(1)];
    bufferState.dirty = true;
    await runChatTurn(turnJob(), 'turn-1');
    // forceNew 必须:此刻 meta 还指向本(active)job,普通排程只会 markDirty
    expect(scheduleTurnMock).toHaveBeenCalledWith(CHAT, { trigger: 'message', forceNew: true });
  });

  it('clears its own scheduledJobId when nothing is left to do', async () => {
    bufferState.pending = [entry(1)];
    await runChatTurn(turnJob(), 'turn-1');
    expect(scheduleTurnMock).not.toHaveBeenCalled();
    expect(bufferState.clearedJobs).toEqual(['turn-1']);
  });

  it('burst overflow keeps older direct entries (≤5) alongside the newest window', async () => {
    const burst = [];
    burst.push(entry(1, true)); // old direct — must survive the cap
    for (let i = 2; i <= 40; i++) burst.push(entry(i));
    bufferState.pending = burst;

    await runChatTurn(turnJob(), 'turn-1');

    const processedIds = processPipelineMock.mock.calls.map((c) => (c[0] as { messageId: number }).messageId);
    expect(processedIds).toContain(1); // direct preserved
    expect(processedIds).toHaveLength(31); // 30 newest + 1 older direct
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

describe('runChatTurn — G3 interrupt/replan', () => {
  const aborted = () => new AIError('aborted', 'x', 'y', 'AI_ABORTED');

  it('replans on AI_ABORTED with the newest pending message as anchor, gate bypassed', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)];

    processPipelineMock.mockImplementationOnce(async () => {
      // Interrupt arrives mid-generation: new messages land in pending
      bufferState.pending = [entry(2), entry(3)];
      throw aborted();
    });

    await runChatTurn(turnJob(), 'turn-1');

    // call 0: judged entry 1 (aborted); call 1: tracking entry 2; call 2: replan judged entry 3
    expect(processPipelineMock).toHaveBeenCalledTimes(3);

    const tracked = processPipelineMock.mock.calls[1]![0] as { messageId: number; coalesce: { isLastInBatch: boolean } };
    expect(tracked.messageId).toBe(2);
    expect(tracked.coalesce.isLastInBatch).toBe(false);

    const replanned = processPipelineMock.mock.calls[2]![0] as {
      messageId: number;
      turnContext: { gateBypass: boolean; isReplan: boolean; signal: AbortSignal };
    };
    expect(replanned.messageId).toBe(3);
    expect(replanned.turnContext.gateBypass).toBe(true);
    expect(replanned.turnContext.isReplan).toBe(true);
    expect(replanned.turnContext.signal).toBeInstanceOf(AbortSignal);
  });

  it('replans with the same anchor when no new messages landed (spurious abort)', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)];
    processPipelineMock.mockRejectedValueOnce(aborted());

    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(2);
    const replanned = processPipelineMock.mock.calls[1]![0] as { messageId: number; turnContext: { gateBypass: boolean } };
    expect(replanned.messageId).toBe(1);
    expect(replanned.turnContext.gateBypass).toBe(true);
  });

  it('drops the reply silently after the replan budget is exhausted', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)];
    processPipelineMock.mockRejectedValue(aborted());

    await runChatTurn(turnJob(), 'turn-1');

    // initial + MAX_REPLANS(2) attempts, then silent drop (no throw)
    expect(processPipelineMock).toHaveBeenCalledTimes(3);
  });

  it('does not replan when TURN_ABORT_ENABLED=false', async () => {
    envState.TURN_ABORT_ENABLED = false;
    bufferState.pending = [entry(1)];
    processPipelineMock.mockRejectedValueOnce(aborted());

    await runChatTurn(turnJob(), 'turn-1');
    expect(processPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('judged entries carry an interruptible signal in turnContext', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)];

    await runChatTurn(turnJob(), 'turn-1');

    const job = processPipelineMock.mock.calls[0]![0] as { turnContext?: { signal?: AbortSignal; epoch?: number } };
    expect(job.turnContext?.signal).toBeInstanceOf(AbortSignal);
    expect(job.turnContext?.epoch).toBe(1);
  });

  it('judged entries of a multi-message burst carry the full burst ids (G4)', async () => {
    bufferState.pending = [entry(1), entry(2), entry(3)];
    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls[2]![0] as { turnContext?: { burstMessageIds?: number[] } };
    expect(judged.turnContext?.burstMessageIds).toEqual([1, 2, 3]);
  });

  it('single-message turns omit burstMessageIds', async () => {
    bufferState.pending = [entry(1)];
    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as { turnContext?: { burstMessageIds?: number[] } };
    expect(judged.turnContext?.burstMessageIds).toBeUndefined();
  });

  it('G5: a lone wait-replay anchor is judged with isWaitReplay + gateBypass', async () => {
    bufferState.pending = [{ ...entry(42), waitReplay: true }];
    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(1);
    const job = processPipelineMock.mock.calls[0]![0] as {
      messageId: number;
      coalesce: { isLastInBatch: boolean };
      turnContext?: { isWaitReplay?: boolean; gateBypass?: boolean };
    };
    expect(job.messageId).toBe(42);
    expect(job.coalesce.isLastInBatch).toBe(true);
    expect(job.turnContext?.isWaitReplay).toBe(true);
    expect(job.turnContext?.gateBypass).toBe(true);
  });

  it('G5: fresher messages displace the wait-replay anchor (re-anchor to newest)', async () => {
    bufferState.pending = [{ ...entry(42), waitReplay: true }, entry(50)];
    await runChatTurn(turnJob(), 'turn-1');

    // Replay entry is skipped entirely; only the fresh message is processed.
    expect(processPipelineMock).toHaveBeenCalledTimes(1);
    const job = processPipelineMock.mock.calls[0]![0] as {
      messageId: number;
      turnContext?: { isWaitReplay?: boolean; burstMessageIds?: number[] };
    };
    expect(job.messageId).toBe(50);
    expect(job.turnContext?.isWaitReplay).toBe(false);
    // Displaced anchor id stays in the burst window so the model can still target it.
    expect(job.turnContext?.burstMessageIds).toEqual([42, 50]);
  });

  it('replan extends the burst window with interrupt-time messages (G4+G3)', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1), entry(2)];

    let firstJudged = true;
    processPipelineMock.mockImplementation(async (job: { coalesce?: { isLastInBatch: boolean } }) => {
      if (job.coalesce?.isLastInBatch && firstJudged) {
        firstJudged = false;
        bufferState.pending = [entry(3)];
        throw new AIError('aborted', 'x', 'y', 'AI_ABORTED');
      }
    });

    await runChatTurn(turnJob(), 'turn-1');

    const lastCall = processPipelineMock.mock.calls.at(-1)![0] as {
      messageId: number;
      turnContext?: { burstMessageIds?: number[] };
    };
    expect(lastCall.messageId).toBe(3);
    expect(lastCall.turnContext?.burstMessageIds).toEqual([1, 2, 3]);
  });
});
