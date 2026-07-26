// ────────────────────────────────────────
// hedge 竞速:赢家返回前必须掐掉输家。
//
// 原实现只用 clearTimeout 取消 hedge,那只在"主标签在 hedgeDelayMs 内先完成"时有效。
// 定时器一旦触发、hedge 的请求已经发出,主标签随后胜出时 Promise.any 直接返回,而没有
// 任何 AbortController 去中止 hedge —— 它跑到底并被 provider 完整计费。HEDGE_DELAY_MS
// 默认 2000,而回复链主模型的延迟远高于 2s,所以这是几乎每次都命中的双重计费。
// ────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

const callModel = vi.fn();

vi.mock('../../../src/ai/provider.js', () => ({ callModel: (...a: unknown[]) => callModel(...a) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = vi.fn().mockResolvedValue(false);
    setCooldown = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: () => ({
    label: 'primary',
    backups: ['hedge'],
    maxTokens: 100,
    temperature: 0.7,
    timeout: 60_000,
  }),
  getLabel: (name: string) => ({ name, model: `model-${name}` }),
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 20 }) }));

const { callWithFallback } = await import('../../../src/ai/fallback.js');

function result(label: string) {
  return {
    content: `from ${label}`,
    tokenUsage: { prompt: 10, completion: 5, total: 15 },
    model: `model-${label}`,
    label,
    latencyMs: 1,
  };
}

describe('hedged call cancels the loser', () => {
  beforeEach(() => callModel.mockReset());

  it('aborts the in-flight hedge once the primary wins', async () => {
    let hedgeAborted = false;

    callModel.mockImplementation((label: { name: string }, _msgs: unknown, opts: { signal?: AbortSignal }) => {
      if (label.name === 'primary') {
        // 比 hedgeDelayMs(20ms) 慢 → hedge 一定会被发出;再稍后胜出。
        return new Promise((res) => setTimeout(() => res(result('primary')), 60));
      }
      // hedge 永不自然完成 —— 只有被 abort 才会结束。
      return new Promise((_res, rej) => {
        opts.signal?.addEventListener('abort', () => {
          hedgeAborted = true;
          rej(new Error('aborted'));
        });
      });
    });

    const r = await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: 'hi' }] });

    expect(r.label).toBe('primary');
    expect(callModel).toHaveBeenCalledTimes(2); // hedge 确实被发出过
    expect(hedgeAborted).toBe(true);            // 且被中止,不会跑到底被计费
  });

  it('aborts the primary when the hedge wins', async () => {
    let primaryAborted = false;

    callModel.mockImplementation((label: { name: string }, _msgs: unknown, opts: { signal?: AbortSignal }) => {
      if (label.name === 'hedge') {
        return new Promise((res) => setTimeout(() => res(result('hedge')), 10));
      }
      return new Promise((_res, rej) => {
        opts.signal?.addEventListener('abort', () => {
          primaryAborted = true;
          rej(new Error('aborted'));
        });
      });
    });

    const r = await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: 'hi' }] });

    expect(r.label).toBe('hedge');
    expect(primaryAborted).toBe(true);
  });

  it('never starts the hedge when the primary beats hedgeDelayMs', async () => {
    callModel.mockImplementation((label: { name: string }) => {
      if (label.name === 'primary') return Promise.resolve(result('primary'));
      return Promise.reject(new Error('hedge should not have been started'));
    });

    const r = await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: 'hi' }] });

    expect(r.label).toBe('primary');
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});
