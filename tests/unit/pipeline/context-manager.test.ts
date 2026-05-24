import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

const mockEval = vi.fn();
const mockHset = vi.fn();
const mockExpire = vi.fn();
const mockZadd = vi.fn();
const mockSadd = vi.fn();

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    eval: (...args: Parameters<typeof mockEval>) => mockEval(...args),
    hset: (...args: Parameters<typeof mockHset>) => mockHset(...args),
    expire: (...args: Parameters<typeof mockExpire>) => mockExpire(...args),
    zadd: (...args: Parameters<typeof mockZadd>) => mockZadd(...args),
    sadd: (...args: Parameters<typeof mockSadd>) => mockSadd(...args),
  }),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ CONTEXT_MAX_LENGTH: 600 }),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { addMessage } = await import('../../../src/pipeline/context/manager.js');

function makeMessage(overrides: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1001,
    username: 'alice',
    fullName: 'Alice',
    timestamp: 1700000000,
    messageId: 1,
    textContent: 'hello',
    isForwarded: false,
    ...overrides,
  };
}

describe('context manager member tracking', () => {
  beforeEach(() => {
    mockEval.mockReset();
    mockEval.mockResolvedValue(1);
    mockHset.mockReset();
    mockHset.mockResolvedValue(1);
    mockExpire.mockReset();
    mockExpire.mockResolvedValue(1);
    mockZadd.mockReset();
    mockZadd.mockResolvedValue(1);
    mockSadd.mockReset();
    mockSadd.mockResolvedValue(1);
  });

  it('tracks regular human messages as group members', async () => {
    await addMessage(-1001, makeMessage());

    expect(mockHset).toHaveBeenCalledTimes(1);
  });

  it('does not track anonymous senders as group members', async () => {
    await addMessage(
      -1001,
      makeMessage({
        uid: -1001,
        username: '',
        fullName: 'Test Group',
        isAnonymous: true,
        anonymousType: 'admin',
      }),
    );

    expect(mockHset).not.toHaveBeenCalled();
  });

  it('does not track channel senders as group members', async () => {
    await addMessage(
      -1001,
      makeMessage({
        uid: -2001,
        username: 'news_channel',
        fullName: 'News Channel',
        isAnonymous: true,
        anonymousType: 'channel',
      }),
    );

    expect(mockHset).not.toHaveBeenCalled();
  });
});
