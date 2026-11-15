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

const { clearQuoteClaim, clearCodeActActive } = await import('../../../src/subagent/task-store.js');

beforeEach(() => {
  getMock.mockReset();
  getMock.mockResolvedValue(null);
  delMock.mockReset();
  delMock.mockResolvedValue(1);
});

describe('local CodeAct settlement requires a confirmed unlock', () => {
  it.each(['get', 'del'])('propagates %s failures in strict mode while preserving best-effort callers', async (operation) => {
    const failing = operation === 'get' ? getMock : delMock;
    failing.mockRejectedValue(new Error('synthetic Redis failure'));
    await expect(clearCodeActActive(-100, 'task-a', { throwOnError: true })).rejects.toThrow('synthetic Redis failure');
    await expect(clearCodeActActive(-100, 'task-a')).resolves.toBeUndefined();
  });

  it('still leaves a different task claim intact in strict mode', async () => {
    getMock.mockResolvedValue('task-b');
    await clearCodeActActive(-100, 'task-a', { throwOnError: true });
    expect(delMock).not.toHaveBeenCalled();
  });
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
