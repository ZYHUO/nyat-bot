import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalMock = vi.fn(async (_script: string, _n: number, _key: string) => [] as string[]);
const lpush = vi.fn();
const rpush = vi.fn();
const ltrim = vi.fn();
const del = vi.fn();
const exec = vi.fn(async () => []);
const multi = vi.fn(() => ({
  lpush: (...a: unknown[]) => {
    lpush(...a);
    return multi();
  },
  rpush: (...a: unknown[]) => {
    rpush(...a);
    return multi();
  },
  ltrim: (...a: unknown[]) => {
    ltrim(...a);
    return multi();
  },
  del: (...a: unknown[]) => {
    del(...a);
    return multi();
  },
  exec,
}));

const envValues: Record<string, unknown> = {
  META_ATTENTION_TOP_N: 8,
  META_L0_COALESCE_MS: 0,
};

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    eval: evalMock,
    multi,
    llen: vi.fn(async () => 0),
    lrange: vi.fn(async () => []),
    del: vi.fn(async () => 1),
  }),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => envValues,
}));

describe('Attention atomic flush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envValues.META_L0_COALESCE_MS = 0;
    envValues.META_ATTENTION_TOP_N = 8;
  });

  it('claims via Lua then returns top-N by pressure', async () => {
    const now = Date.now();
    const low = {
      id: 'low',
      chatId: -1,
      layer: 'L2',
      pressure: 10,
      reason: 'x',
      createdAt: now - 5000,
    };
    const high = {
      id: 'high',
      chatId: -1,
      layer: 'L0',
      pressure: 100,
      reason: 'y',
      createdAt: now - 4000,
    };
    evalMock.mockResolvedValueOnce([JSON.stringify(low), JSON.stringify(high)]);

    const { getAttentionAccumulator, _resetAttentionAccumulator } = await import(
      '../../../src/meta/attention.js'
    );
    _resetAttentionAccumulator();
    const picked = await getAttentionAccumulator().flush(1);
    expect(evalMock).toHaveBeenCalled();
    expect(picked).toHaveLength(1);
    expect(picked[0]!.id).toBe('high');
    expect(rpush).toHaveBeenCalled();
  });

  it('holds hot L0 chats until coalesce quiet window', async () => {
    envValues.META_L0_COALESCE_MS = 5000;
    const now = Date.now();
    const fresh = {
      id: 'hot',
      chatId: -1001,
      layer: 'L0',
      pressure: 100,
      reason: 'nickname',
      createdAt: now - 200,
      messageId: 1,
    };
    evalMock.mockResolvedValueOnce([JSON.stringify(fresh)]);
    const { getAttentionAccumulator, _resetAttentionAccumulator } = await import(
      '../../../src/meta/attention.js'
    );
    _resetAttentionAccumulator();
    rpush.mockClear();
    const picked = await getAttentionAccumulator().flush(8);
    expect(picked).toHaveLength(0);
    expect(rpush).toHaveBeenCalled();
  });
});
