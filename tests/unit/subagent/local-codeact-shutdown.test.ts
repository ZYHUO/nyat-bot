import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
const f = vi.hoisted(() => ({ add: vi.fn(), queueClose: vi.fn(), workerClose: vi.fn(), persist: vi.fn(), activation: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { add(...args: unknown[]) { return f.add(...args); } close() { return f.queueClose(); } },
  Worker: class { on() { return this; } close() { return f.workerClose(); } },
  DelayedError: class extends Error {},
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_CONCURRENCY: 1 }) }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ putTask() {} }) }));
vi.mock('../../../src/subagent/task-store.js', () => ({
  tryMarkCodeActActive: vi.fn(), clearCodeActActive: vi.fn(), persistCodeActTask: (...args: unknown[]) => f.persist(...args),
}));
vi.mock('../../../src/subagent/activation-policy.js', () => ({
  checkCodeActTaskActivation: () => ({ allowed: true }), holdCodeActTask: vi.fn(), requireCodeActActivation: () => f.activation(),
}));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { LocalCodeActQueue } from '../../../src/subagent/local-queue.js';
import { CodeActAdmissionHeldError, _resetCodeActLifecycleForTest, registerLocalCodeActLifecycle } from '../../../src/subagent/work-lifecycle.js';
import { closeCodeActWorker, enqueueCodeActJob, enqueueResumeCodeActJob, getCodeActQueue, startCodeActWorker } from '../../../src/subagent/queue.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const task = (id: string, chatId = 123): DispatchTask => ({ id, chatId, createdAt: 1, status: 'queued', contentDirection: 'synthetic' });
let local: LocalCodeActQueue;
let run: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCodeActLifecycleForTest();
  for (const mock of Object.values(f)) mock.mockReset().mockResolvedValue(undefined);
  run = vi.fn().mockResolvedValue(undefined);
  claim = vi.fn().mockResolvedValue(true);
  release = vi.fn().mockResolvedValue(undefined);
  local = new LocalCodeActQueue({ concurrency: () => 1,
    claim: work => claim(work), run: work => run(work), release: work => release(work), failed: () => {} });
  registerLocalCodeActLifecycle(local);
  getCodeActQueue(); startCodeActWorker();
});
afterEach(async () => {
  local.resetForTest();
  _resetCodeActLifecycleForTest();
  f.workerClose.mockResolvedValue(undefined);
  await closeCodeActWorker();
  vi.useRealTimers();
});

describe('CodeAct fallback shutdown composition', () => {
  it('joins an actual local send and its settlement before queue/store closure, including concurrent closes', async () => {
    const sending = deferred(); const settling = deferred(); const started = deferred();
    run.mockImplementation(async () => { started.resolve(); await sending.promise; });
    release.mockImplementation(() => settling.promise);
    local.enqueue(task('active')); await started.promise;
    const first = closeCodeActWorker(); const second = closeCodeActWorker();
    expect(first).toBe(second);
    await Promise.resolve(); expect(f.queueClose).not.toHaveBeenCalled();
    expect(() => local.enqueue(task('late'))).toThrow('codeact_draining');
    sending.resolve(); await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(f.queueClose).not.toHaveBeenCalled();
    settling.resolve(); await first;
    expect(f.queueClose).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
  });

  it('does not start a late claim, and refuses a clean exit when local pending work has no durable queue receipt', async () => {
    const claiming = deferred<boolean>(); claim.mockReturnValue(claiming.promise);
    local.enqueue(task('claimed-late')); await Promise.resolve();
    const closing = closeCodeActWorker();
    const rejected = expect(closing).rejects.toThrow('codeact_local_pending_without_queue_receipt');
    claiming.resolve(true); await rejected;
    expect(run).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(f.queueClose).not.toHaveBeenCalled();
  });

  it('preserves pending same-chat fallback work and never launches it during drain', async () => {
    const sending = deferred(); const started = deferred();
    run.mockImplementation(async () => { started.resolve(); await sending.promise; });
    local.enqueue(task('first')); local.enqueue(task('pending')); await started.promise;
    const rejected = expect(closeCodeActWorker()).rejects.toThrow('codeact_local_pending_without_queue_receipt');
    sending.resolve(); await rejected;
    expect(run).toHaveBeenCalledOnce(); expect(f.queueClose).not.toHaveBeenCalled();
  });

  it('waits for an admission started before drain and rejects new producers without writes', async () => {
    const persisted = deferred(); const started = deferred();
    f.persist.mockImplementation(async () => { started.resolve(); await persisted.promise; });
    const producing = enqueueCodeActJob(task('before')); await started.promise;
    const closing = closeCodeActWorker();
    await expect(enqueueCodeActJob(task('after'))).rejects.toThrow('codeact_draining');
    await Promise.resolve(); expect(f.queueClose).not.toHaveBeenCalled(); expect(f.persist).toHaveBeenCalledOnce();
    persisted.resolve(); await producing; await closing;
    expect(f.add).toHaveBeenCalledWith('codeact', expect.objectContaining({ id: 'before' }), { jobId: 'codeact-before' });
    expect(f.queueClose).toHaveBeenCalledOnce();
  });

  it('lets a running task persist its next segment durably and waits for that producer', async () => {
    const finishSegment = deferred(); const started = deferred();
    run.mockImplementation(async () => {
      started.resolve(); await finishSegment.promise;
      await enqueueResumeCodeActJob({ ...task('continued'), segment: 2 });
    });
    local.enqueue(task('running')); await started.promise;
    const closing = closeCodeActWorker(); finishSegment.resolve(); await closing;
    expect(f.add).toHaveBeenCalledWith('codeact', expect.objectContaining({ id: 'continued' }), {
      jobId: 'codeact-continued-seg2', attempts: 1,
    });
    await expect(enqueueResumeCodeActJob(task('too-late'))).rejects.toThrow('codeact_draining');
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['claim', 'execution', 'settlement'])('refuses a clean handoff after a local %s failure without retrying', async (phase) => {
    const active = deferred(); const started = deferred();
    const work = phase === 'claim' ? claim : phase === 'execution' ? run : release;
    work.mockImplementation(async () => { started.resolve(); await active.promise; return true; });
    local.enqueue(task('unreceipted')); await started.promise;
    const closing = expect(closeCodeActWorker()).rejects.toThrow('codeact_local_failed_without_queue_receipt');
    active.reject(new Error(`synthetic ${phase} failure`));
    await closing;
    expect(f.queueClose).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledTimes(phase === 'claim' ? 0 : 1);
    await expect(closeCodeActWorker()).rejects.toThrow('codeact_local_failed_without_queue_receipt');
    expect(claim).toHaveBeenCalledOnce();
  });

  it('retains a rejected admission even when it leaves the set before worker close finishes', async () => {
    const adding = deferred(); const started = deferred(); const worker = deferred();
    f.add.mockImplementation(async () => { started.resolve(); await adding.promise; });
    f.workerClose.mockReturnValue(worker.promise);
    const admitted = enqueueCodeActJob(task('not-in-bullmq')); await started.promise;
    const closing = expect(closeCodeActWorker()).rejects.toThrow('codeact_admission_failed_during_drain');
    const rejected = expect(admitted).rejects.toThrow('synthetic add failure');
    adding.reject(new Error('synthetic add failure')); await rejected;
    worker.resolve(); await closing;
    expect(f.queueClose).not.toHaveBeenCalled();
    expect(f.add).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a failed local continuation from authorizing a clean handoff', async () => {
    const finishSegment = deferred(); const started = deferred();
    run.mockImplementation(async () => {
      started.resolve(); await finishSegment.promise;
      await enqueueResumeCodeActJob({ ...task('continued'), segment: 2 });
    });
    f.add.mockRejectedValue(new Error('synthetic continuation add failure'));
    local.enqueue(task('running')); await started.promise;
    const closing = expect(closeCodeActWorker()).rejects.toThrow('codeact_local_failed_without_queue_receipt');
    finishSegment.resolve(); await closing;
    expect(f.queueClose).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce(); expect(f.add).toHaveBeenCalledOnce();
  });

  it('does not poison shutdown for a policy refusal already archived or a historical rejection', async () => {
    f.activation.mockRejectedValueOnce(new Error('historical admission rejection'));
    await expect(enqueueCodeActJob(task('historical'))).rejects.toThrow('historical admission rejection');
    const policy = deferred(); const started = deferred();
    f.activation.mockImplementationOnce(async () => { started.resolve(); await policy.promise; });
    const held = enqueueCodeActJob(task('held')); await started.promise;
    const closing = closeCodeActWorker();
    const rejected = expect(held).rejects.toThrow('codeact_activation_denied:chat_outside_scope');
    policy.reject(new CodeActAdmissionHeldError('codeact_activation_denied:chat_outside_scope'));
    await rejected; await closing;
    expect(f.add).not.toHaveBeenCalled(); expect(f.queueClose).toHaveBeenCalledOnce();
  });

  it('backs off a busy chat, lets other chats run, and cancels claim retries when draining', async () => {
    vi.useFakeTimers();
    claim.mockImplementation(async (work: DispatchTask) => work.chatId !== 123);
    local.enqueue(task('busy')); local.enqueue(task('other-chat', 456));
    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_499); expect(claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(claim).toHaveBeenCalledTimes(3);
    await expect(closeCodeActWorker()).rejects.toThrow('codeact_local_pending_without_queue_receipt');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000); expect(claim).toHaveBeenCalledTimes(3);
  });
});
