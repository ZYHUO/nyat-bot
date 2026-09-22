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

  // round 1（新 goal）反转：L0（@ / 回 bot / 叫昵称 / DM）**不再** hold。
  //
  // 用户报 20+ 秒延迟 + 前言不搭后语。subagent 七天实测段1 里
  // META_L0_COALESCE_MS=2800 的静默窗是纯亏：人家在直接找 bot，
  // 却又等了 2.8 秒。DM 早就豁免，群里的 direct 却要陪跑。
  // 合并只对 L2（被动消息）保留——那种确实是"看看要不要接话"。
  it('L0 direct 不再 hold（等 2.8s 静默窗对直呼是纯亏）', async () => {
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
    expect(picked).toHaveLength(1);   // ← 旧行为是 0（被 hold）
    expect(picked[0]!.id).toBe('hot');
  });

  it('L2 被动消息仍然 hold（合并窗只对"要不要接话"生效）', async () => {
    envValues.META_L0_COALESCE_MS = 5000;
    const now = Date.now();
    const fresh = {
      id: 'passive',
      chatId: -1002,
      layer: 'L2',
      pressure: 50,
      reason: 'passive',
      createdAt: now - 200,
      messageId: 2,
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
