import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const addMock = vi.fn();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({})
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = addMock;
    close = vi.fn();
  },
}));

describe('queue producer job ids', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    addMock.mockReset();
    addMock.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
    }));
  });

  it('uses dash-delimited versioned ids and processes two edits in the same second once each', async () => {
    const { enqueue } = await import('../../../src/queue/producer.js');
    const data = {
      type: 'message',
      chatId: -100123,
      messageId: 42,
      isEdit: true,
      enqueuedAt: 100000,
      update: { update_id: 1, edited_message: { message_id: 42, edit_date: 99, text: 'first' } },
    } as const;
    const id = await enqueue(data);
    const second = await enqueue({ ...data, update: { update_id: 2, edited_message: { message_id: 42, edit_date: 99, text: 'second' } } });
    const replay = await enqueue(data);

    expect(id).toMatch(/^msg--100123-42-edit-[a-f0-9]{64}$/);
    expect(second).not.toBe(id); expect(replay).toBe(id);
    expect(addMock).toHaveBeenCalledWith('message', expect.anything(), expect.objectContaining({
      jobId: id,
    }));
    expect(id).not.toContain(':');
  });

  it('wait enqueue retries preserve generation, payload and the original deadline', async () => {
    const { enqueueWaitResume } = await import('../../../src/queue/producer.js');
    vi.spyOn(Date, 'now').mockReturnValue(103000);
    const timing = { waitGeneration: 'synthetic-generation', scheduledAt: 100000, waitUntil: 105000 };
    const first = await enqueueWaitResume(-100, 5, 42, 'obligation-1', timing);
    const retry = await enqueueWaitResume(-100, 5, 42, 'obligation-1', timing);
    expect(first).toBe('wait--100-synthetic-generation');
    expect(retry).toBe(first);
    expect(addMock).toHaveBeenCalledWith('wait_resume', expect.objectContaining({
      enqueuedAt: 100000, waitResume: { ...timing, waitSec: 5, anchorMessageId: 42, obligationId: 'obligation-1' },
    }), expect.objectContaining({ jobId: first, delay: 2000, attempts: 3 }));
  });
});
