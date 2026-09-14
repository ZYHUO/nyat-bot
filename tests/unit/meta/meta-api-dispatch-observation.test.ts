import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const { state, recordMetaDispatchObservation, dispatchCodeActTaskViaAgency, enqueueCodeActJob, isCodeActBusy, tryClaimQuote, tryMarkCodeActActive, allQuotesAnswered } = vi.hoisted(() => ({
  state: {
    listTasks: vi.fn(),
    putTask: vi.fn(),
    getTask: vi.fn(),
  },
  recordMetaDispatchObservation: vi.fn(),
  dispatchCodeActTaskViaAgency: vi.fn(),
  enqueueCodeActJob: vi.fn(),
  isCodeActBusy: vi.fn(),
  tryClaimQuote: vi.fn(),
  tryMarkCodeActActive: vi.fn(),
  allQuotesAnswered: vi.fn(),
}));

vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => state }));
vi.mock('../../../src/meta/flags.js', () => ({ isMetaSubagentChat: () => true }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/agent/agency-meta-observation.js', () => ({ recordMetaDispatchObservation }));
vi.mock('../../../src/agent/agency-codeact-dispatch.js', () => ({ dispatchCodeActTaskViaAgency }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  isCodeActBusy,
  tryClaimQuote,
  tryMarkCodeActActive,
  clearQuoteClaim: vi.fn(async () => undefined),
  clearCodeActActive: vi.fn(async () => undefined),
  persistCodeActTask: vi.fn(async () => undefined),
}));
vi.mock('../../../src/meta/answered.js', () => ({ allQuotesAnswered }));
vi.mock('../../../src/meta/heart-refractory.js', () => ({ shouldSuppressMetaHeartDispatch: vi.fn(async () => false) }));
vi.mock('../../../src/shared/message-text.js', () => ({
  sanitizeContentDirection: (text: string) => text,
}));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueCodeActJob }));

import { buildMetaApiContext } from '../../../src/meta/meta-api.js';

beforeEach(() => {
  state.listTasks.mockReset();
  state.listTasks.mockReturnValue([]);
  state.putTask.mockReset();
  state.getTask.mockReset();
  recordMetaDispatchObservation.mockReset();
  recordMetaDispatchObservation.mockResolvedValue({ ok: true });
  dispatchCodeActTaskViaAgency.mockReset();
  dispatchCodeActTaskViaAgency.mockResolvedValue({ attempted: false, accepted: false, reason: 'disabled' });
  enqueueCodeActJob.mockReset();
  enqueueCodeActJob.mockResolvedValue(undefined);
  isCodeActBusy.mockReset();
  isCodeActBusy.mockResolvedValue(false);
  tryClaimQuote.mockReset();
  tryClaimQuote.mockResolvedValue(true);
  tryMarkCodeActActive.mockReset();
  tryMarkCodeActActive.mockResolvedValue(true);
  allQuotesAnswered.mockReset();
  allQuotesAnswered.mockResolvedValue(false);
});

describe('Meta dispatch observation wiring', () => {
  it('keeps legacy queue authoritative while observing a proposed dispatch', async () => {
    const context = buildMetaApiContext({
      chatLayer: new Map([[-100, 'L0']]),
      defaultCognitiveAnchorEventIds: new Map([[-100, 'cognitive-event-1']]),
    });
    const dispatch = (context.dispatch as { taskToGroup: (chatId: number, args: Record<string, unknown>) => Promise<{ taskId: string }> }).taskToGroup;

    const result = await dispatch(-100, {
      contentDirection: '处理这个任务',
      quotes: [101],
      targetUserId: 42,
      interrupt: true,
    });

    expect(result.taskId).not.toMatch(/^skipped|^blocked/);
    expect(enqueueCodeActJob).toHaveBeenCalledOnce();
    const task = enqueueCodeActJob.mock.calls[0]![0] as DispatchTask;
    expect(task).toMatchObject({
      chatId: -100,
      quoteMessageIds: [101],
      targetUserId: 42,
      cognitiveAnchorEventId: 'cognitive-event-1',
    });
    expect(recordMetaDispatchObservation).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100,
      layer: 'L0',
      quoteMessageIds: [101],
      taskId: task.id,
      decision: 'proposed',
      cognitiveAnchorEventId: 'cognitive-event-1',
    }));
  });

  it('records an L2 block without queueing or inventing a task', async () => {
    const context = buildMetaApiContext({
      chatLayer: new Map([[-100, 'L2']]),
      defaultQuotes: new Map([[-100, 202]]),
    });
    const dispatch = (context.dispatch as { taskToGroup: (chatId: number, args: Record<string, unknown>) => Promise<{ taskId: string }> }).taskToGroup;

    await expect(dispatch(-100, { contentDirection: '背景观察' })).resolves.toEqual({ taskId: 'blocked_l2' });
    expect(enqueueCodeActJob).not.toHaveBeenCalled();
    expect(recordMetaDispatchObservation).toHaveBeenCalledWith(expect.objectContaining({
      quoteMessageIds: [202],
      decision: 'blocked',
      decisionReason: 'l2_interrupt_required',
    }));
  });
});
