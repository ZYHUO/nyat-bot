import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const f = vi.hoisted(() => ({
  config: { BOT_TOKEN: '12345:test-only', META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [42], META_ACTIVATED_AT_SEC: 100 },
  archive: vi.fn(async () => 1), state: vi.fn(), persist: vi.fn(), send: vi.fn(), collect: vi.fn(),
  get: vi.fn(), hget: vi.fn(async () => null), assignment: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hsetnx: f.archive, get: f.get, hget: f.hget }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected_database_access'); } }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: f.state }));
vi.mock('../../../src/subagent/task-store.js', () => ({ persistCodeActTask: f.persist }));
vi.mock('../../../src/subagent/prompt-inputs.js', () => ({ collectPromptInputs: f.collect }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendChatAction: f.send, sendMessage: f.send, sendSticker: f.send, reactToMessage: f.send }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/platform/onebot-assignment-store.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/platform/onebot-assignment-store.js')>();
  return { ...original, assertOneBotAssignmentTask: f.assignment };
});
import { OneBotAssignmentError } from '../../../src/platform/onebot-assignment-store.js';
import { runCodeActTask } from '../../../src/subagent/executor.js';

beforeEach(() => {
  vi.clearAllMocks();
  f.config.META_SUBAGENT_ENABLED = true;
  f.config.META_ACTIVATED_AT_SEC = 100;
  f.get.mockResolvedValue(null);
  f.state.mockReset();
  f.assignment.mockReset().mockReturnValue(null);
});
describe('executor activation boundary on local and resumed tasks', () => {
  it.each([0, 4])('holds old segment %i before state, persistence, prompt collection or typing', async (segment) => {
    const task: DispatchTask = { id: 'synthetic-held', chatId: 42, createdAt: 99000, status: 'queued', segment, contentDirection: 'old synthetic task' };
    const before = structuredClone(task);
    await runCodeActTask(task);
    expect(task).toEqual(before);
    expect(f.archive).toHaveBeenCalledOnce();
    const args = f.archive.mock.calls[0] as unknown as [string, string, string];
    expect(args[0]).toBe('xxb:codeact:activation-held');
    expect(JSON.parse(args[2])).toMatchObject({ reason: 'predates_activation', task: before });
    for (const effect of [f.state, f.persist, f.send, f.collect]) expect(effect).not.toHaveBeenCalled();
  });
  it('holds new tasks if Meta is switched off after enqueue', async () => {
    f.config.META_SUBAGENT_ENABLED = false;
    await runCodeActTask({ id: 'synthetic-new', chatId: 42, createdAt: 101000, status: 'queued', contentDirection: 'new synthetic task' });
    expect(f.archive).toHaveBeenCalledOnce();
    expect(f.state).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'unavailable'])('holds %s checkpoint before any execution instead of replaying from scratch', async reason => {
    const task: DispatchTask = { id: 'resumed', chatId: 42, createdAt: 101000, status: 'queued', segment: 2, contentDirection: 'resume task', checkpointKey: 'xxb:agent:checkpoint:resumed' };
    if (reason === 'invalid') f.get.mockResolvedValue(JSON.stringify({ taskId: task.id, history: [{ role: 'system', content: 'FOREIGN_PRIVATE_CONTEXT' }] }));
    if (reason === 'unavailable') f.get.mockRejectedValue(new Error('redis unavailable'));
    await runCodeActTask(task);
    expect(f.archive).toHaveBeenCalledOnce();
    const args = f.archive.mock.calls[0] as unknown as [string, string, string];
    expect(JSON.parse(args[2]).reason).toBe(`checkpoint_${reason}`);
    for (const effect of [f.state, f.persist, f.send, f.collect]) expect(effect).not.toHaveBeenCalled();
    expect(task.status).toBe('queued');
  });

  it('restores cumulative budgets before constructing the task runtime/host', async () => {
    const task: DispatchTask = { id: 'resumed', chatId: 42, createdAt: 101000, status: 'queued', contentDirection: 'resume', checkpointKey: 'xxb:agent:checkpoint:resumed', sendsUsed: 1 };
    f.get.mockResolvedValue(JSON.stringify({
      version: 2, taskId: task.id, source: { platform: 'telegram', accountId: '12345', chatId: 42, conversationKind: 'private', threadId: 0 },
      contentDirection: 'resume', history: [], progressSummary: '', artifacts: [], segment: 2, totalTurns: 30, sendsUsed: 3, updatedAt: 100001,
    }));
    f.state.mockImplementation(() => { throw new Error('stop_before_runtime_construction'); });
    await expect(runCodeActTask(task)).rejects.toThrow('stop_before_runtime_construction');
    expect(task.sendsUsed).toBe(3);
    expect(task.totalTurns).toBe(30);
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});


describe('assignment execution and resume fence', () => {
  it.each([0, 2])('checks persistent grant before executing segment %s, including checkpoint reads', async segment => {
    const task: DispatchTask = { id: 'assigned', chatId: 42, createdAt: 101000, status: 'queued', segment,
      contentDirection: 'group task', qqAssignmentId: 'grant', ...(segment ? { checkpointKey: 'checkpoint' } : {}) };
    f.assignment.mockImplementation(() => { throw new OneBotAssignmentError('expired'); });
    await runCodeActTask(task);
    expect(f.assignment).toHaveBeenCalledWith(task, { executionStart: true });
    expect(task).toMatchObject({ status: 'failed', resultSummary: 'failed_qq_assignment_expired' });
    expect(f.persist).toHaveBeenCalledWith(task);
    for (const effect of [f.get, f.state, f.send, f.collect]) expect(effect).not.toHaveBeenCalled();
  });
  it.each(['held', 'pending_reservation'])('retains an explicit unknown-delivery hold for %s', async code => {
    const task: DispatchTask = { id: 'reserved', chatId: 42, createdAt: 101000, status: 'queued', contentDirection: 'do not resend', qqAssignmentId: 'grant' };
    f.assignment.mockImplementation(() => { throw new OneBotAssignmentError(code); });
    await runCodeActTask(task);
    expect(task.resultSummary).toBe('failed_delivery_unknown_no_retry');
    expect(f.archive).toHaveBeenCalledWith('xxb:codeact:delivery-unknown', task.id, expect.any(String));
    expect(f.send).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled();
  });
  it('rejects copied private pending input before prompt collection', async () => {
    const task: DispatchTask = { id: 'injected', chatId: 42, createdAt: 101000, status: 'queued',
      contentDirection: 'target task', qqAssignmentId: 'grant', pendingUserInput: [{ text: 'PRIVATE_DM_CANARY' }] };
    f.assignment.mockReturnValue({ id: 'grant', targetChatId: 42, mode: 'once' });
    await runCodeActTask(task);
    expect(task.resultSummary).toBe('failed_qq_assignment_foreign_context');
    expect(f.collect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
});
