import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock, delMock } = vi.hoisted(() => ({
  getMock: vi.fn(async () => null as string | null),
  delMock: vi.fn(async () => 1),
}));

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: (...args: unknown[]) => getMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  }),
}));

const { clearQuoteClaim } = await import('../../../src/subagent/task-store.js');

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue(null);
  delMock.mockReset();
  delMock.mockResolvedValue(1);
});

describe('CodeAct quote claim cleanup', () => {
  it('deletes a claim only when it belongs to the task', async () => {
    getMock.mockResolvedValueOnce('task-a');

    await clearQuoteClaim(-100, 42, 'task-a');

    expect(getMock).toHaveBeenCalledWith('xxb:meta:quote_claim:-100:42');
    expect(delMock).toHaveBeenCalledWith('xxb:meta:quote_claim:-100:42');
  });

  it('does not delete another task claim', async () => {
    getMock.mockResolvedValueOnce('task-b');

    await clearQuoteClaim(-100, 42, 'task-a');

    expect(delMock).not.toHaveBeenCalled();
  });

  it('ignores invalid message ids without touching Redis', async () => {
    await clearQuoteClaim(-100, 0, 'task-a');

    expect(getMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });
});
