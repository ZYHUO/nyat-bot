import { describe, expect, it, vi, beforeEach } from 'vitest';

const addMock = vi.fn();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({})
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = addMock;
    close = vi.fn();
  },
}));

describe('queue producer job ids', () => {
  beforeEach(() => {
    addMock.mockReset();
    addMock.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
    }));
  });

  it('uses dash-delimited ids for edited messages', async () => {
    const { enqueue } = await import('../../../src/queue/producer.js');

    const id = await enqueue({
      type: 'message',
      chatId: -100123,
      messageId: 42,
      isEdit: true,
    } as never);

    expect(id).toBe('msg--100123-42-edit');
    expect(addMock).toHaveBeenCalledWith('message', expect.anything(), expect.objectContaining({
      jobId: 'msg--100123-42-edit',
    }));
    expect(id).not.toContain(':');
  });
});
