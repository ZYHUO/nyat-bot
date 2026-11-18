import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { MessageJobData } from '../../../src/queue/jobs.js';

const f = vi.hoisted(() => ({
  process: undefined as ((job: Job<MessageJobData>, token?: string) => Promise<void>) | undefined,
  wait: vi.fn(), pipeline: vi.fn(), turn: vi.fn(), defer: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_name: string, process: typeof f.process) { f.process = process; }
    on() { return this; }
    async close() {}
  },
  UnrecoverableError: class extends Error {},
  DelayedError: class extends Error {},
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ QUEUE_CONCURRENCY: 1 }) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/pipeline/pipeline.js', () => ({ processPipeline: f.pipeline }));
vi.mock('../../../src/pipeline/turn/actor.js', () => ({ runChatTurn: f.turn }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ handleWaitResume: f.wait }));
vi.mock('../../../src/pipeline/timing/defer.js', () => ({ handleDeferResume: f.defer }));
import { DelayedError } from 'bullmq';
import { closeWorker, startWorker } from '../../../src/queue/worker.js';

beforeEach(async () => { await closeWorker(); vi.clearAllMocks(); f.wait.mockReset().mockResolvedValue(undefined); startWorker(); });
function job() {
  return { id: 'stored-job-id', data: { type: 'wait_resume', chatId: -100,
    waitResume: { scheduledAt: 1000, waitSec: 5, waitGeneration: 'gen-1', waitUntil: 6000 } },
    moveToDelayed: vi.fn(async () => {}) };
}
describe('wait worker routing', () => {
  it('passes the actual queue job identity to the atomic claim', async () => {
    const current = job();
    await f.process!(current as unknown as Job<MessageJobData>, 'lock-token');
    expect(f.wait).toHaveBeenCalledWith({ chatId: -100, waitResume: current.data.waitResume, jobId: current.id });
    expect(f.pipeline).not.toHaveBeenCalled();
  });
  it('moves an early job to its exact deadline without completing or failing it', async () => {
    const current = job(); f.wait.mockResolvedValue({ status: 'early', waitUntil: 6000 });
    await expect(f.process!(current as unknown as Job<MessageJobData>, 'lock-token')).rejects.toBeInstanceOf(DelayedError);
    expect(current.moveToDelayed).toHaveBeenCalledWith(6000, 'lock-token');
    expect(f.pipeline).not.toHaveBeenCalled();
  });
  it('propagates a Redis claim failure to the bounded queue retry', async () => {
    const current = job(); f.wait.mockRejectedValue(new Error('synthetic claim failure'));
    await expect(f.process!(current as unknown as Job<MessageJobData>, 'lock-token')).rejects.toThrow('synthetic claim failure');
    expect(current.moveToDelayed).not.toHaveBeenCalled();
  });
});
