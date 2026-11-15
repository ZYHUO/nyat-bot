import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ workerClose: vi.fn(), queueClose: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { close() { return f.queueClose(); } },
  Worker: class { on() { return this; } close() { return f.workerClose(); } },
  DelayedError: class extends Error {},
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_CONCURRENCY: 1 }) }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({}) }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  tryMarkCodeActActive: vi.fn(), clearCodeActActive: vi.fn(), persistCodeActTask: vi.fn(),
}));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { closeCodeActWorker, getCodeActQueue, startCodeActWorker } from '../../../src/subagent/queue.js';
import { _resetCodeActLifecycleForTest } from '../../../src/subagent/work-lifecycle.js';
beforeEach(() => {
  _resetCodeActLifecycleForTest();
  vi.useFakeTimers();
  f.workerClose.mockReset().mockResolvedValue(undefined);
  f.queueClose.mockReset().mockResolvedValue(undefined);
  getCodeActQueue(); startCodeActWorker();
});
afterEach(async () => {
  f.workerClose.mockResolvedValue(undefined); f.queueClose.mockResolvedValue(undefined);
  await closeCodeActWorker(); vi.useRealTimers();
});
describe('shutdown requires actual CodeAct drain', () => {
  it.each(['worker', 'queue'])('does not report success while %s is still running', async (kind) => {
    let finish!: () => void;
    (kind === 'worker' ? f.workerClose : f.queueClose).mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    let completed = false;
    const pending = closeCodeActWorker().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(completed).toBe(false);
    if (kind === 'worker') expect(f.queueClose).not.toHaveBeenCalled();
    finish(); await pending; expect(f.queueClose).toHaveBeenCalledOnce();
  });
  it('propagates a close failure and retains the worker for a later retry', async () => {
    f.workerClose.mockRejectedValueOnce(new Error('synthetic close failure'));
    await expect(closeCodeActWorker()).rejects.toThrow('synthetic close failure');
    expect(f.queueClose).not.toHaveBeenCalled();
    await closeCodeActWorker(); expect(f.workerClose).toHaveBeenCalledTimes(2);
  });
  it('normal completion clears handles without closing them twice', async () => {
    await closeCodeActWorker(); await closeCodeActWorker();
    expect(f.workerClose).toHaveBeenCalledOnce(); expect(f.queueClose).toHaveBeenCalledOnce();
  });
});
