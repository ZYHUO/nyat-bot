import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';

const mocks = vi.hoisted(() => ({
  config: { META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true,
    META_SUBAGENT_CHAT_IDS: [12345] as number[], META_ACTIVATED_AT_SEC: 1_800_000_000, CODEACT_CONCURRENCY: 1 },
  archive: vi.fn(), add: vi.fn(), put: vi.fn(), persist: vi.fn(), lock: vi.fn(), clear: vi.fn(),
  run: vi.fn(), local: vi.fn(), event: vi.fn(),
  processor: undefined as undefined | ((job: { data: DispatchTask; discard: () => void }) => Promise<void>),
}));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hsetnx: mocks.archive }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ putTask: mocks.put }) }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: mocks.event }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  persistCodeActTask: mocks.persist, tryMarkCodeActActive: mocks.lock, clearCodeActActive: mocks.clear,
}));
vi.mock('../../../src/subagent/executor.js', () => ({ runCodeActTask: mocks.run, enqueueSubagentTaskLocal: mocks.local }));
vi.mock('bullmq', () => ({
  Queue: class { add(...args: unknown[]) { return mocks.add(...args); } async close() {} },
  Worker: class {
    constructor(_name: string, processor: NonNullable<typeof mocks.processor>) { mocks.processor = processor; }
    on() { return this; }
    async close() {}
  },
  DelayedError: class extends Error {},
}));

import { checkCodeActActivation, holdCodeActTask } from '../../../src/subagent/activation-policy.js';
import { enqueueCodeActJob, enqueueResumeCodeActJob, startCodeActWorker, closeCodeActWorker } from '../../../src/subagent/queue.js';

const activationMs = 1_800_000_000_000;
const task = (overrides: Partial<DispatchTask> = {}): DispatchTask => ({
  id: 'test-task', chatId: 12345, createdAt: activationMs, status: 'queued', contentDirection: 'synthetic task', ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.config, { META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true,
    META_SUBAGENT_CHAT_IDS: [12345], META_ACTIVATED_AT_SEC: 1_800_000_000 });
  mocks.archive.mockResolvedValue(1);
  mocks.add.mockResolvedValue({ id: 'accepted' });
  mocks.persist.mockResolvedValue(undefined);
  mocks.lock.mockResolvedValue(true);
  mocks.clear.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue(undefined);
});
afterEach(async () => { await closeCodeActWorker(); });

describe('CodeAct activation policy', () => {
  it('accepts only enabled, isolated, scoped work created at or after the fixed epoch', () => {
    expect(checkCodeActActivation(task())).toEqual({ allowed: true });
    expect(checkCodeActActivation(task({ createdAt: activationMs + 1 }))).toEqual({ allowed: true });
    expect(checkCodeActActivation(task({ createdAt: activationMs - 1 }))).toEqual({ allowed: false, reason: 'predates_activation' });
    expect(checkCodeActActivation(task({ chatId: -100 }))).toEqual({ allowed: false, reason: 'chat_outside_scope' });
    expect(checkCodeActActivation(task(), { ...mocks.config, META_SUBAGENT_ENABLED: false })).toEqual({ allowed: false, reason: 'meta_disabled' });
    expect(checkCodeActActivation(task(), { ...mocks.config, CODEACT_ISOLATION_ENABLED: false })).toEqual({ allowed: false, reason: 'isolation_disabled' });
  });

  it('fails closed on missing timestamps, wrong units, invalid chat IDs and malformed epochs', () => {
    for (const createdAt of [undefined, null, '1800000000000', NaN, Infinity, -1, 1.5]) {
      expect(checkCodeActActivation({ chatId: 12345, createdAt })).toEqual({ allowed: false, reason: 'invalid_created_at' });
    }
    expect(checkCodeActActivation({ chatId: 12345, createdAt: 1_800_000_000 })).toEqual({ allowed: false, reason: 'predates_activation' });
    for (const chatId of [0, '12345', NaN, Infinity, 1.5]) {
      expect(checkCodeActActivation({ chatId, createdAt: activationMs })).toEqual({ allowed: false, reason: 'invalid_chat' });
    }
    expect(checkCodeActActivation(task(), { ...mocks.config, META_ACTIVATED_AT_SEC: NaN })).toEqual({ allowed: false, reason: 'invalid_activation_epoch' });
  });

  it('allows deliberate all-chat scope but refuses a missing or zero activation epoch', () => {
    expect(checkCodeActActivation(task({ chatId: -100 }), {
      ...mocks.config, META_SUBAGENT_CHAT_IDS: [],
    })).toEqual({ allowed: true });
    expect(checkCodeActActivation(task(), { ...mocks.config, META_ACTIVATED_AT_SEC: 0 })).toEqual({ allowed: false, reason: 'invalid_activation_epoch' });
    const { META_ACTIVATED_AT_SEC: _epoch, ...missingEpoch } = mocks.config;
    expect(checkCodeActActivation(task(), missingEpoch)).toEqual({ allowed: false, reason: 'invalid_activation_epoch' });
    expect(checkCodeActActivation(task(), {})).toEqual({ allowed: false, reason: 'meta_disabled' });
  });

  it('archives the original task with first-write semantics and no mutation', async () => {
    const original = task({ createdAt: activationMs - 1000, segment: 3 });
    const before = structuredClone(original);
    await holdCodeActTask(original, 'predates_activation');
    expect(original).toEqual(before);
    const [key, id, raw] = mocks.archive.mock.calls[0]!;
    expect(key).toBe('xxb:codeact:activation-held');
    expect(id).toBe(original.id);
    expect(JSON.parse(String(raw))).toMatchObject({ reason: 'predates_activation', task: before });
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});

describe('queue authority before execution', () => {
  it('holds a native Telegram task contaminated with a QQ quote before queue or worker side effects', async () => {
    const contaminated = task({ relatedQuoteIds: [2 ** 52 + 99] });
    await expect(enqueueCodeActJob(contaminated)).rejects.toThrow('task_scope_invalid');
    expect(mocks.add).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
    startCodeActWorker(); const discard = vi.fn();
    await expect(mocks.processor!({ data: contaminated, discard })).rejects.toThrow('task_scope_invalid');
    expect(discard).toHaveBeenCalledOnce(); expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    expect(JSON.parse(String(mocks.archive.mock.calls[0]![2])).task.relatedQuoteIds).toEqual([2 ** 52 + 99]);
  });
  it('rejects new queue and resume entries before lifecycle writes or local fallback', async () => {
    await expect(enqueueCodeActJob(task({ chatId: -100 }))).rejects.toThrow('chat_outside_scope');
    await expect(enqueueResumeCodeActJob(task({ createdAt: activationMs - 1, segment: 4 }))).rejects.toThrow('predates_activation');
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    for (const fn of [mocks.add, mocks.put, mocks.persist, mocks.local, mocks.event]) expect(fn).not.toHaveBeenCalled();
  });

  it('checks queued work against the current policy again before claiming a chat or calling the executor', async () => {
    const accepted = task();
    await enqueueCodeActJob(accepted);
    expect(mocks.add).toHaveBeenCalledOnce();
    mocks.config.META_SUBAGENT_CHAT_IDS = [-200];
    startCodeActWorker();
    const discard = vi.fn();
    await expect(mocks.processor!({ data: accepted, discard })).rejects.toThrow('chat_outside_scope');
    expect(discard).toHaveBeenCalledOnce();
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('holds restored old jobs and does not retry them after the archive is durable', async () => {
    startCodeActWorker();
    const discard = vi.fn();
    await expect(mocks.processor!({ data: task({ createdAt: activationMs - 1 }), discard })).rejects.toThrow('predates_activation');
    expect(discard).toHaveBeenCalledOnce();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('does not execute or discard work when preserving the archive fails', async () => {
    mocks.archive.mockRejectedValueOnce(new Error('archive unavailable'));
    startCodeActWorker();
    const discard = vi.fn();
    await expect(mocks.processor!({ data: task({ createdAt: activationMs - 1 }), discard })).rejects.toThrow('archive unavailable');
    expect(discard).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it('executes an allowed task and releases its chat lock', async () => {
    startCodeActWorker();
    const accepted = task();
    const discard = vi.fn();
    await mocks.processor!({ data: accepted, discard });
    expect(mocks.run).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(mocks.clear).toHaveBeenCalledWith(accepted.chatId, accepted.id);
    expect(mocks.archive).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});
