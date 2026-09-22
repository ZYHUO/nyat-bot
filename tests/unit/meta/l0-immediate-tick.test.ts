import { beforeEach, describe, expect, it, vi } from 'vitest';

// round 4 回归：L0 直呼必须**立刻** kick metaTick，不等 META_TICK_MS=5000 栅格。
//
// 2026-09-22 用户报 4-6s + 10-16s + 3-4s 叠加迟钝。七天实测段①
// （message in → Heart decision）P50 8.2s = Heart 自己 4.8s + reflect 1.2s
// + **等 tick 最多 5s**。round 1 只让 L0 跳过了 coalesce hold，栅格还在——修了一半。
//
// 锁两个性质：
//   ① L0 ingest → 排一次 tick（不等栅格）
//   ② L2 ingest → 不排（等栅格更接近"看看要不要接话"的人为节奏；
//      实测 114/119 条入站都是 L2，全 kick 等于没有栅格）

let scheduled: number[] = [];
let loopImported = false;

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    multi: () => {
      const pipe = { lpush: () => pipe, ltrim: () => pipe, exec: async () => [] };
      return pipe;
    },
    eval: vi.fn(async () => []),
    llen: vi.fn(async () => 0),
    lrange: vi.fn(async () => []),
    del: vi.fn(async () => 1),
  }),
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({
    META_L0_COALESCE_MS: 0,
    META_ATTENTION_TOP_N: 8,
    META_SUBAGENT_ENABLED: true,
    META_TICK_MS: 5000,
  }),
}));

// 关键：mock loop.js，记 metaTick 被调
vi.mock('../../../src/meta/loop.js', () => ({
  metaTick: vi.fn(async () => {
    loopImported = true;
    scheduled.push(Date.now());
  }),
}));

import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';

describe('L0 直呼立刻 kick metaTick', () => {
  beforeEach(() => {
    _resetAttentionAccumulator();
    scheduled = [];
    loopImported = false;
  });

  it('① L0 ingest → 排一次 tick', async () => {
    await getAttentionAccumulator().ingestAsync({
      chatId: -1001,
      layer: 'L0',
      reason: 'direct:mention',
      messageId: 1,
      userId: 5,
      textPreview: '在吗',
      createdAt: Date.now(),
    });
    // scheduleCoalesceWake 有 50ms 下限（Math.max(50, ...)），等它
    await new Promise((r) => setTimeout(r, 120));
    expect(loopImported).toBe(true);
  }, 3000);

  it('② L2 ingest → 不排 tick（等栅格）', async () => {
    await getAttentionAccumulator().ingestAsync({
      chatId: -1002,
      layer: 'L2',
      reason: 'passive',
      messageId: 2,
      userId: 6,
      textPreview: '今天天气不错',
      createdAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(loopImported).toBe(false);
  }, 3000);
});
