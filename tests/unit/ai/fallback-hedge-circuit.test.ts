import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-08-07 线上事故回归:
// 1) hedge 丢失败方计入熔断 —— 主跳超时后 hedge 已发出,主跳失败导致 hedge 被 abort,
//    abort 被 hedgePromise reject 路径记为一次 hedge 模型失败。k27code "Empty response"
//    + 无辜 timeout 双杀,熔断退避被刷到 405s+,冻住 summarize 链 → deep-reflection 全灭。
// 2) hedge 赢主跳失败时不重置主跳熔断计数(注释里写明的设计意图)。

const { callModelMock, recordFailureMock, recordSuccessMock } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
  recordFailureMock: vi.fn(async (): Promise<boolean> => false),
  recordSuccessMock: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['hedge', 'last'], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({ name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model` })),
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async (): Promise<boolean> => false;
    setCooldown = async (): Promise<void> => {};
    recordSuccess = recordSuccessMock;
    recordFailure = recordFailureMock;
  },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 5 }) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';

const res = (content: string, label: string) => ({
  content, label, model: `${label}-model`, latencyMs: 1,
  tokenUsage: { promptTokens: 1, completionTokens: 1, total: 2 },
});
const opts = { usage: 'heart', messages: [{ role: 'user' as const, content: 'hi' }], rejectEmpty: true };

beforeEach(() => {
  callModelMock.mockReset();
  recordFailureMock.mockClear();
  recordSuccessMock.mockClear();
});

describe('hedge loser abort 不计熔断 (2026-08-07 outage)', () => {
  it('hedge 赢、主跳慢到 hedgeDelay 后失败 → 主跳计失败,hedge 只记成功不记失败', async () => {
    callModelMock.mockImplementation((label?: { name: string }, _m?: unknown, o?: { signal?: AbortSignal }) => {
      if (label?.name === 'primary') {
        return new Promise((_res, rej) => {
          o?.signal?.addEventListener('abort', () => rej(o.signal.reason ?? new Error('aborted')));
          setTimeout(() => rej(new Error('primary timeout')), 30);
        });
      }
      return Promise.resolve(res('hedge-win', label?.name ?? '?'));
    });
    const r = await callWithFallback(opts);
    expect(r.content).toBe('hedge-win');
    // primary 失败 → 计一次失败(熔断需要)
    expect(recordFailureMock.mock.calls.filter((c) => c[0] === 'primary-model')).toHaveLength(1);
    // hedge 被 abort 是"输家",不是真实故障 → 绝不能计失败
    expect(recordFailureMock.mock.calls.filter((c) => c[0] === 'hedge-model')).toHaveLength(0);
    expect(recordSuccessMock.mock.calls.filter((c) => c[0] === 'hedge-model').length).toBeGreaterThan(0);
  });

  it('主跳赢、hedge 在飞被 abort → hedge 不计失败', async () => {
    callModelMock.mockImplementation((label?: { name: string }, _m?: unknown, o?: { signal?: AbortSignal }) => {
      if (label?.name === 'hedge') {
        return new Promise((_res, rej) => {
          o?.signal?.addEventListener('abort', () => rej(o.signal.reason ?? new Error('aborted')));
          setTimeout(() => rej(new Error('hedge would-be timeout')), 100);
        });
      }
      return Promise.resolve(res('primary-win', label?.name ?? '?'));
    });
    // hedge delay 5ms,primary 立即返回 → hedge 可能没发出;让它发出:primary 慢 20ms
    callModelMock.mockImplementation((label?: { name: string }, _m?: unknown, o?: { signal?: AbortSignal }) => {
      if (label?.name === 'primary') {
        return new Promise((res2) => setTimeout(() => res2(res('primary-win', 'primary')), 20));
      }
      return new Promise((_r, rej) => {
        o?.signal?.addEventListener('abort', () => rej(o.signal.reason ?? new Error('aborted')));
      });
    });
    const r = await callWithFallback(opts);
    expect(r.content).toBe('primary-win');
    expect(recordFailureMock.mock.calls.filter((c) => c[0] === 'hedge-model')).toHaveLength(0);
  });
});
