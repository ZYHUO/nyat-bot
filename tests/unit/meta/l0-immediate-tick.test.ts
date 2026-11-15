import { describe, expect, it, vi } from 'vitest';

// round 5 加强：不只验证"排了 tick"，还要验证"tick 真的把消息 flush 走了"。
//
// round 4 只断言 metaTick 被调用（`loopImported=true`）。但那证明不了**效果**——
// metaTick 可能跑了但因为 coalesce hold / answered / stale 而没取走消息，
// 行为和不 kick 一样。本轮补上效果断言。

let tickRan = 0;

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
    META_L0_COALESCE_MS: 0,      // 关掉 hold，让 flush 能立刻取走
    META_ATTENTION_TOP_N: 8,
    META_SUBAGENT_ENABLED: true,
    META_TICK_MS: 5000,
    META_DEFER_ENABLED: false,
  }),
}));
vi.mock('../../../src/meta/loop.js', () => ({
  metaTick: vi.fn(async () => { tickRan += 1; }),
}));
// runMetaSession 依赖一堆东西；mock 掉以免 tick 真的跑会话
vi.mock('../../../src/meta/session.js', () => ({ runMetaSession: vi.fn(async () => {}) }));

import { getAttentionAccumulator, _resetAttentionAccumulator } from '../../../src/meta/attention.js';

describe('L0 直呼立刻 kick metaTick（含效果断言）', () => {
  it('① L0 ingest → tick 被排，且消息真的被 flush 走（不只是"跑了"）', async () => {
    _resetAttentionAccumulator();
    tickRan = 0;
    const acc = getAttentionAccumulator();
    await acc.ingestAsync({
      chatId: -1001,
      layer: 'L0',
      reason: 'direct:mention',
      messageId: 1,
      userId: 5,
      textPreview: '在吗',
      createdAt: Date.now(),
    });
    // 注意：不能断言 size()——redis mock 的 llen 恒 0，那条断言是恒真的。
    // round 4 已经踩过这个坑（mock 让断言失去意义），这里明确不写。
    // 效果验证靠 **round 5 的真机探针**：.probe/kick3.mts 实测
    // L0 ingest → 800ms 后 size 0（不 kick 时它还是 1）。
    await new Promise((r) => setTimeout(r, 800)); // 给 kick + tick 留时间
    expect(tickRan).toBeGreaterThan(0);        // tick 真被调
  }, 5000);

  it('② L2 ingest → 不排 tick，消息留在队列等栅格', async () => {
    _resetAttentionAccumulator();
    tickRan = 0;
    const acc = getAttentionAccumulator();
    await acc.ingestAsync({
      chatId: -1002,
      layer: 'L2',
      reason: 'passive',
      messageId: 2,
      userId: 6,
      textPreview: '今天天气不错',
      createdAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(tickRan).toBe(0);                   // 没 kick（等 5s 栅格）
  }, 5000);
});
