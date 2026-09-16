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
  // review R3#4:per-person 抑制开关必须有初值 + 在 beforeEach 复位,否则
  // 设过它的用例会把 true 泄漏给后续用例,悄悄翻转 WAIT 抑制分支。
  TURN_WAIT_PER_PERSON: false as boolean,
  TURN_EXEC_LOCK_ENABLED: false as boolean,
  TURN_EXEC_LOCK_TTL_MS: 120_000,
  TURN_GATE_DEFER_MAX_REPLAYS: 1,
};

const { processPipelineMock, scheduleTurnMock, transitionToRunningMock, appendPendingMock, acquireLockMock, renewLockMock, releaseLockMock } = vi.hoisted(() => ({
  processPipelineMock: vi.fn(async () => {}),
  scheduleTurnMock: vi.fn(async () => {}),
  transitionToRunningMock: vi.fn(async () => {}),
  appendPendingMock: vi.fn(async () => ({ count: 1, firstPendingAt: 0 })),
  acquireLockMock: vi.fn(async () => true),
  renewLockMock: vi.fn(async () => true),
  releaseLockMock: vi.fn(async () => {}),
}));

vi.mock('../../../src/pipeline/turn/turn-lock.js', () => ({
  acquireTurnLock: acquireLockMock,
  renewTurnLock: renewLockMock,
  releaseTurnLock: releaseLockMock,
}));

const bufferState: {
  pending: PendingEntry[];
  dirty: boolean;
  epoch: number;
  clearedJobs: string[];
  postDrainPendingCount: number;
} = { pending: [], dirty: false, epoch: 0, clearedJobs: [], postDrainPendingCount: 0 };

let chatState: { state: 'RUNNING' | 'WAIT' | 'STOP'; waitTriggerUids?: number[]; waitTopicKey?: string } = { state: 'RUNNING' };

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
// P2-F:wait 回访对照 activity 时间线判断窗口期有无新消息
const { getRecentTimestampsMock } = vi.hoisted(() => ({
  getRecentTimestampsMock: vi.fn(async (): Promise<number[]> => []),
}));
vi.mock('../../../src/tracking/activity.js', () => ({ getRecentTimestamps: getRecentTimestampsMock }));
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
  hasPendingDirect: vi.fn(async () => false),
  appendPending: appendPendingMock,
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

function cmdEntry(messageId: number, text: string): PendingEntry {
  return {
    update: { update_id: messageId, message: { message_id: messageId, chat: { id: CHAT, type: 'supergroup' }, from: { id: 100 + messageId }, text } } as never,
    chatId: CHAT,
    messageId,
    enqueuedAt: Date.now(),
    direct: true,
  };
}

function turnJob(trigger: 'message' | 'direct' | 'wait_timeout' = 'message') {
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
  envState.TURN_WAIT_PER_PERSON = false;
  envState.TURN_EXEC_LOCK_ENABLED = false;
  appendPendingMock.mockClear();
  acquireLockMock.mockClear();
  acquireLockMock.mockResolvedValue(true);
  renewLockMock.mockClear();
  releaseLockMock.mockClear();
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

  it('every slash command in a burst is judged — 两个人同窗 /checkin 各自有回执', async () => {
    bufferState.pending = [cmdEntry(1, '/checkin'), cmdEntry(2, '/checkin')];
    await runChatTurn(turnJob('direct'), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(2);
    const flags = processPipelineMock.mock.calls.map(
      (c) => (c[0] as { coalesce: { isLastInBatch: boolean } }).coalesce.isLastInBatch,
    );
    expect(flags).toEqual([true, true]); // 命令是事务,不受单锚点预算约束
  });

  it('command + passive message: 命令有回执,普通消息仍按聊天锚点考虑', async () => {
    bufferState.pending = [entry(1), cmdEntry(2, '/checkin')];
    await runChatTurn(turnJob('direct'), 'turn-1');

    const judged = processPipelineMock.mock.calls
      .map((c) => c[0] as { messageId: number; coalesce: { isLastInBatch: boolean } })
      .filter((j) => j.coalesce.isLastInBatch)
      .map((j) => j.messageId);
    expect(judged.sort()).toEqual([1, 2]); // 签到回执不吞掉 #1 的聊天考虑
  });

  it('command addressed to another bot is NOT command-judged', async () => {
    bufferState.pending = [{ ...cmdEntry(1, '/start@other_bot'), direct: false }, entry(2)];
    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls
      .map((c) => c[0] as { messageId: number; coalesce: { isLastInBatch: boolean } })
      .filter((j) => j.coalesce.isLastInBatch)
      .map((j) => j.messageId);
    expect(judged).toEqual([2]); // 别家的命令只是普通条目
  });

  it('an edit is never the default anchor — the newest non-edit entry is judged (review #0/#3)', async () => {
    bufferState.pending = [entry(1), { ...entry(2), isEdit: true }];
    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(2);
    const judged = processPipelineMock.mock.calls
      .map((c) => c[0] as { messageId: number; coalesce: { isLastInBatch: boolean } })
      .filter((j) => j.coalesce.isLastInBatch);
    expect(judged).toHaveLength(1);
    expect(judged[0]!.messageId).toBe(1);
  });

  it('an all-edit passive burst is tracking-only (typo 修正不该唤醒 bot)', async () => {
    bufferState.pending = [{ ...entry(1), isEdit: true }, { ...entry(2), isEdit: true }];
    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(2);
    for (const call of processPipelineMock.mock.calls) {
      expect((call[0] as { coalesce: { isLastInBatch: boolean } }).coalesce.isLastInBatch).toBe(false);
    }
  });

  it('a direct edit (@bot 改出来的) still anchors via the direct scan (review #8)', async () => {
    bufferState.pending = [entry(1), { ...entry(2, true), isEdit: true }];
    await runChatTurn(turnJob('direct'), 'turn-1');

    const judged = processPipelineMock.mock.calls
      .map((c) => c[0] as { messageId: number; coalesce: { isLastInBatch: boolean } })
      .filter((j) => j.coalesce.isLastInBatch);
    expect(judged).toHaveLength(1);
    expect(judged[0]!.messageId).toBe(2);
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

  it('WAIT per-person suppression does not swallow a new topic from the same uid', async () => {
    envState.TIMING_GATE_ENABLED = true;
    envState.TURN_WAIT_PER_PERSON = true as never;
    // wait 时锚定了话题 key,新消息话题不同 → 不被吞。(无 topicKey 的
    // WAIT 按 legacy 整人抑制,见下一个用例。)
    chatState = { state: 'WAIT', waitTriggerUids: [101], waitTopicKey: 'r0:上一个话题' };
    bufferState.pending = [
      {
        update: { message: { message_id: 1, chat: { id: CHAT, type: 'supergroup' }, from: { id: 101, first_name: 'A' }, text: '新话题怎么搞' } } as never,
        chatId: CHAT,
        messageId: 1,
        enqueuedAt: Date.now(),
      },
    ];

    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as { skipReply?: boolean; coalesce: { isLastInBatch: boolean } };
    expect(judged.skipReply).toBeUndefined();
    expect(judged.coalesce.isLastInBatch).toBe(true);
  });

  it('WAIT per-person suppression still suppresses the same uid', async () => {
    envState.TIMING_GATE_ENABLED = true;
    envState.TURN_WAIT_PER_PERSON = true as never;
    chatState = { state: 'WAIT', waitTriggerUids: [101] };
    bufferState.pending = [
      {
        update: { message: { message_id: 1, chat: { id: CHAT, type: 'supergroup' }, from: { id: 101, first_name: 'A' }, text: '老话题继续' } } as never,
        chatId: CHAT,
        messageId: 1,
        enqueuedAt: Date.now(),
      },
    ];

    await runChatTurn(turnJob(), 'turn-1');

    const tracked = processPipelineMock.mock.calls[0]![0] as { skipReply?: boolean; coalesce: { isLastInBatch: boolean } };
    expect(tracked.skipReply).toBe(true);
    expect(tracked.coalesce.isLastInBatch).toBe(false);
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
    expect(scheduleTurnMock).toHaveBeenCalledWith(CHAT, { trigger: 'message', direct: false, forceNew: true });
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

  it('commands interrupting a turn each get their receipt, non-interruptibly (几个人同窗 /checkin)', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)]; // a chat message starts the turn

    processPipelineMock.mockImplementationOnce(async () => {
      // mid-generation: two people /checkin + a chat msg land
      bufferState.pending = [cmdEntry(2, '/checkin'), cmdEntry(3, '/checkin'), entry(4)];
      throw aborted();
    });

    await runChatTurn(turnJob(), 'turn-1');

    const byId = (id: number) => processPipelineMock.mock.calls.find((c) => (c[0] as { messageId: number }).messageId === id);
    // BOTH checkins must be processed (not collapsed to one anchor)
    expect(byId(2)).toBeDefined();
    expect(byId(3)).toBeDefined();
    // commands run non-interruptibly (no signal) + gate bypassed
    for (const id of [2, 3]) {
      const tc = (byId(id)![0] as { turnContext?: { signal?: unknown; gateBypass?: boolean } }).turnContext;
      expect(tc?.signal).toBeUndefined();
      expect(tc?.gateBypass).toBe(true);
    }
    // the chat message (4) is still the replan anchor (interruptible → has a signal)
    const anchorTc = (byId(4)![0] as { turnContext?: { signal?: unknown } }).turnContext;
    expect(anchorTc?.signal).toBeInstanceOf(AbortSignal);
  });

  it('replan anchors on the direct entry, not the newest interjection', async () => {
    // 修复:用户 reply bot(direct)后别人紧跟插话,replan 无条件取
    // fresh.at(-1) 会把点名挤掉,bot 跑去回应插话话题(2026-06-12 反馈,
    // 日志实例 msg 75953"糖")。锚点选择须与 runChatTurn 一致:direct 优先。
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)];

    processPipelineMock.mockImplementationOnce(async () => {
      bufferState.pending = [entry(2, true), entry(3)];
      throw aborted();
    });

    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(3);
    // 非锚点条目(3)tracking-only 入册
    const tracked = processPipelineMock.mock.calls[1]![0] as { messageId: number; coalesce: { isLastInBatch: boolean } };
    expect(tracked.messageId).toBe(3);
    expect(tracked.coalesce.isLastInBatch).toBe(false);
    // 锚点是 direct 条目(2),且按 direct 语义开火
    const replanned = processPipelineMock.mock.calls[2]![0] as {
      messageId: number;
      coalesce: { flushReason: string };
      turnContext: { isReplan: boolean };
    };
    expect(replanned.messageId).toBe(2);
    expect(replanned.coalesce.flushReason).toBe('direct_interaction');
    expect(replanned.turnContext.isReplan).toBe(true);
  });

  it('replan skips edit entries as anchor when no direct entry exists', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(1)];

    processPipelineMock.mockImplementationOnce(async () => {
      bufferState.pending = [entry(2), { ...entry(3), isEdit: true }];
      throw aborted();
    });

    await runChatTurn(turnJob(), 'turn-1');

    expect(processPipelineMock).toHaveBeenCalledTimes(3);
    const replanned = processPipelineMock.mock.calls[2]![0] as { messageId: number };
    expect(replanned.messageId).toBe(2);
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

describe('runChatTurn — P0-B deferReplay / P2-F waitResume', () => {
  it('review R2#10(critical):defer 回放条目只跳 bookkeeping,**不**跳 judge/heart(isWaitReplay 必须是 false,否则会被强制 REPLY 绕过全部节流),不 gateBypass,deferCount 透传', async () => {
    bufferState.pending = [{ ...entry(1), deferReplay: true, deferCount: 1 }];

    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      turnContext?: { isWaitReplay?: boolean; isDeferReplay?: boolean; gateBypass?: boolean; deferCount?: number };
    };
    // isWaitReplay=false 是关键不变量:true 会让 pipeline 把这条消息强制
    // 判成 REPLY(rule=turn_replan∈DIRECT_INTERACTION_RULES)并跳过
    // judge/heart,gate 也会因 isDirectInteraction 直接放行——defer 存在
    // 的意义(到点重新裁决)就整个失效了(review #10,曾经的真实回归)。
    expect(judged.turnContext?.isWaitReplay).toBe(false);
    expect(judged.turnContext?.isDeferReplay).toBe(true);
    expect(judged.turnContext?.gateBypass).toBe(false);
    expect(judged.turnContext?.deferCount).toBe(1);
  });

  it('defer 回放遇到更新的真实消息 → 让位(新消息当锚点,defer id 留在 burst 窗口)', async () => {
    bufferState.pending = [
      { ...entry(1), deferReplay: true, deferCount: 1 },
      entry(2),
    ];

    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      messageId: number;
      turnContext?: { burstMessageIds?: number[]; deferCount?: number };
    };
    expect(judged.messageId).toBe(2);
    expect(judged.turnContext?.burstMessageIds).toEqual([1, 2]);
    // 新锚点不是 defer 条目,不继承 deferCount
    expect(judged.turnContext?.deferCount).toBeUndefined();
  });

  it('wait 回放(期间彻底沉默)→ waitResume={waitSec, hadNewMessages:false} + gateBypass', async () => {
    getRecentTimestampsMock.mockResolvedValue([]);
    bufferState.pending = [{ ...entry(1), waitReplay: true, waitSec: 30, waitStartedAt: Date.now() - 30_000 }];

    await runChatTurn(turnJob('wait_timeout'), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      turnContext?: { waitResume?: { waitSec?: number; hadNewMessages: boolean }; gateBypass?: boolean };
    };
    expect(judged.turnContext?.waitResume).toEqual({ waitSec: 30, hadNewMessages: false });
    expect(judged.turnContext?.gateBypass).toBe(true);
  });

  it('review #7:窗口期消息被中间回合消化 → activity 时间线仍能判出 hadNewMessages:true', async () => {
    const waitStartedAt = Date.now() - 30_000;
    // wait 开始后 10s 群里有人说话(该消息已被中间回合 trackEntry,不在本批)
    getRecentTimestampsMock.mockResolvedValue([Math.floor((waitStartedAt + 10_000) / 1000)]);
    bufferState.pending = [{ ...entry(1), waitReplay: true, waitSec: 30, waitStartedAt }];

    await runChatTurn(turnJob('wait_timeout'), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      turnContext?: { waitResume?: { waitSec?: number; hadNewMessages: boolean } };
    };
    expect(judged.turnContext?.waitResume).toEqual({ waitSec: 30, hadNewMessages: true });
  });

  it('wait 回放被新消息挤掉 → 提示挂到新锚点,hadNewMessages:true', async () => {
    bufferState.pending = [
      { ...entry(1), waitReplay: true, waitSec: 45 },
      entry(2),
    ];

    await runChatTurn(turnJob('wait_timeout'), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      messageId: number;
      turnContext?: { waitResume?: { waitSec?: number; hadNewMessages: boolean } };
    };
    expect(judged.messageId).toBe(2);
    expect(judged.turnContext?.waitResume).toEqual({ waitSec: 45, hadNewMessages: true });
  });

  it('review #8:睡眠补回条目(waitReplay+sleepCatchup)不误判为 wait 回访', async () => {
    bufferState.pending = [{ ...entry(1), waitReplay: true, sleepCatchup: true }];

    await runChatTurn(turnJob('wait_timeout'), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      turnContext?: { waitResume?: unknown };
    };
    expect(judged.turnContext?.waitResume).toBeUndefined();
  });

  it('review R2#2/R2#8:waitResume 判定不依赖回合 trigger(handleWaitResume 的 scheduleTurn 不带 forceNew,回合被合并/复用时 trigger 会变成 message/direct,曾经的 trigger 门槛会让提示在最该生效的活跃群里失效)', async () => {
    bufferState.pending = [{ ...entry(1), waitReplay: true, waitSec: 30 }];

    // 即使触发这个回合的 trigger 是 'message'(coalesce 复用/markDirty 收尾
    // 重排都会产生这个 trigger),drain 出来的条目自身带 waitReplay=true,
    // 就该构造 waitResume —— 判定依据是条目本身,不是触发回合的 trigger。
    await runChatTurn(turnJob('message'), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      turnContext?: { waitResume?: { waitSec?: number; hadNewMessages: boolean } };
    };
    expect(judged.turnContext?.waitResume).toEqual({ waitSec: 30, hadNewMessages: false });
  });

  it('review R1#10:回合开始的 timing 快照透传给每个 judged entry', async () => {
    envState.TIMING_GATE_ENABLED = true;
    chatState = { state: 'RUNNING' };
    bufferState.pending = [entry(1)];

    await runChatTurn(turnJob(), 'turn-1');

    const judged = processPipelineMock.mock.calls[0]![0] as {
      turnContext?: { timingStateSnapshot?: unknown };
    };
    expect(judged.turnContext?.timingStateSnapshot).toBe(chatState);
  });

  it('review R2#4:defer 回放条目落进 WAIT per-person 抑制(trackEntry 路径)时也要跳过 bookkeeping,防止 addMessage 把同一条消息第二次写进上下文', async () => {
    envState.TIMING_GATE_ENABLED = true;
    envState.TURN_WAIT_PER_PERSON = true as never;
    chatState = { state: 'WAIT', waitTriggerUids: [101] };
    bufferState.pending = [
      {
        update: { message: { message_id: 1, chat: { id: CHAT, type: 'supergroup' }, from: { id: 101, first_name: 'A' }, text: '重放条目' } } as never,
        chatId: CHAT,
        messageId: 1,
        enqueuedAt: Date.now(),
        deferReplay: true,
        deferCount: 1,
      },
    ];

    await runChatTurn(turnJob(), 'turn-1');

    const tracked = processPipelineMock.mock.calls[0]![0] as {
      skipReply?: boolean;
      turnContext?: { isWaitReplay?: boolean; isDeferReplay?: boolean };
    };
    // 走的是 trackEntry(非 judged)路径,但首轮已经入过账 —— 必须显式
    // 跳过 bookkeeping,否则这条消息会在 Redis 上下文列表里出现两次。
    expect(tracked.skipReply).toBe(true);
    expect(tracked.turnContext?.isWaitReplay).toBe(false);
    expect(tracked.turnContext?.isDeferReplay).toBe(true);
  });

  it('review R2#4:普通(非回放)条目落进 trackEntry 时不带 turnContext(维持原行为,不误伤既有路径)', async () => {
    envState.TIMING_GATE_ENABLED = true;
    envState.TURN_WAIT_PER_PERSON = true as never;
    chatState = { state: 'WAIT', waitTriggerUids: [101] };
    bufferState.pending = [
      {
        update: { message: { message_id: 1, chat: { id: CHAT, type: 'supergroup' }, from: { id: 101, first_name: 'A' }, text: '老话题继续' } } as never,
        chatId: CHAT,
        messageId: 1,
        enqueuedAt: Date.now(),
      },
    ];

    await runChatTurn(turnJob(), 'turn-1');

    const tracked = processPipelineMock.mock.calls[0]![0] as { turnContext?: unknown };
    expect(tracked.turnContext).toBeUndefined();
  });
});

describe('G12 执行期互斥锁(TURN_EXEC_LOCK_ENABLED)', () => {
  it('flag off → 不碰锁,原路径零变化', async () => {
    bufferState.pending = [entry(1)];
    await runChatTurn(turnJob(), 'turn-1');
    expect(acquireLockMock).not.toHaveBeenCalled();
    expect(processPipelineMock).toHaveBeenCalledTimes(1);
  });

  it('锁忙 → 不 drain(不偷 burst)、排 noReschedule 短延迟重试', async () => {
    envState.TURN_EXEC_LOCK_ENABLED = true;
    acquireLockMock.mockResolvedValue(false);
    bufferState.pending = [entry(1)];

    await runChatTurn(turnJob(), 'turn-loser');

    expect(processPipelineMock).not.toHaveBeenCalled();
    expect(bufferState.pending.length).toBe(1); // burst 原封不动留给持锁回合
    expect(scheduleTurnMock).toHaveBeenCalledTimes(1);
    expect(scheduleTurnMock.mock.calls[0]![1]).toMatchObject({
      noReschedule: true,
      delayMsOverride: 2_500,
    });
    expect(releaseLockMock).not.toHaveBeenCalled(); // 没拿到就没资格放
  });

  it('拿到锁 → 跑完回合后 finally 放锁(含收尾 reschedule 之后)', async () => {
    envState.TURN_EXEC_LOCK_ENABLED = true;
    bufferState.pending = [entry(1)];
    bufferState.postDrainPendingCount = 1; // 收尾发现新 pending → forceNew 重排

    const order: string[] = [];
    scheduleTurnMock.mockImplementation(async () => { order.push('reschedule'); });
    releaseLockMock.mockImplementation(async () => { order.push('release'); });

    await runChatTurn(turnJob(), 'turn-winner');

    expect(processPipelineMock).toHaveBeenCalledTimes(1);
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
    // 放锁必须在收尾 reschedule 之后 —— 唤醒不丢的关键顺序
    expect(order).toEqual(['reschedule', 'release']);
  });

  it('回合内部抛错 → finally 仍放锁(锁不泄漏)', async () => {
    envState.TURN_EXEC_LOCK_ENABLED = true;
    bufferState.pending = [entry(1)];
    // drain 级错误会浮出 runChatTurnInner(entry 级错误会被吞)
    const { drainPending } = await import('../../../src/pipeline/turn/buffer.js');
    vi.mocked(drainPending).mockRejectedValueOnce(new Error('redis down'));

    await expect(runChatTurn(turnJob(), 'turn-crash')).rejects.toThrow('redis down');
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
  });
});

describe('关机契约(shutdown requeue)', () => {
  it('关机广播后被 abort 的锚点条目 → 回 pending(deferReplay)不再 replan,回合正常返回', async () => {
    const { abortAllGenerations } = await import('../../../src/pipeline/turn/abort-registry.js');
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(7)];
    abortAllGenerations(); // 先广播:registerGeneration 返回预中止 controller
    processPipelineMock.mockRejectedValueOnce(
      Object.assign(new Error('shutdown'), { name: 'Shutdown' }),
    );

    await runChatTurn(turnJob(), 'turn-shutdown');

    expect(processPipelineMock).toHaveBeenCalledTimes(1); // 无 replan 二进宫
    expect(appendPendingMock).toHaveBeenCalledTimes(1);
    expect(appendPendingMock.mock.calls[0]![0]).toMatchObject({
      messageId: 7,
      deferReplay: true,
    });
  });

  it('对照:未关机时同样的 abort 走 replan 重规划(既有语义不回归)', async () => {
    envState.TURN_ABORT_ENABLED = true;
    bufferState.pending = [entry(8)];
    processPipelineMock
      .mockRejectedValueOnce(Object.assign(new Error('turn_interrupt: x'), { name: 'TurnInterrupt' }))
      .mockResolvedValueOnce(undefined);

    await runChatTurn(turnJob(), 'turn-replan');

    expect(processPipelineMock).toHaveBeenCalledTimes(2); // replan 后重试
    expect(appendPendingMock).not.toHaveBeenCalled();
  });
});
