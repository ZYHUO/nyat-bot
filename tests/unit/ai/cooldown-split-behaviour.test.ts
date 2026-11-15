import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 冷却分级的行为测试（round 182 补）。
 *
 * 上面 cooldown-split.test.ts 查的是源码结构。这里**真的调**
 * `callWithFallback`，断言两种错误形状走的是不同冷却时长——
 * AGENTS.md：「A grep guard proves the string, not the logic.」
 */

const { callModelMock, isCoolingDownMock, remainingMock, setCooldownCalls } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
  isCoolingDownMock: vi.fn(),
  remainingMock: vi.fn(),
  // 记下每次 setCooldown 的 (model, sec)——sec 缺省 = 短期冷却
  setCooldownCalls: [] as Array<{ model: string; sec?: number }>,
}));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../src/ai/labels.js', () => ({
  getLabel: vi.fn((name: string) => ({ name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model` })),
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['hedge', 'last'], timeout: 30000 })),
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = isCoolingDownMock;
    setCooldown = async (model: string, sec?: number): Promise<void> => { setCooldownCalls.push({ model, sec }); };
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
    getRemainingSeconds = remainingMock;
  },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 0 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';

const base = { usage: 'heart', messages: [{ role: 'user' as const, content: 'hi' }], rejectEmpty: true };

beforeEach(() => {
  callModelMock.mockReset();
  isCoolingDownMock.mockReset();
  remainingMock.mockReset();
  setCooldownCalls.length = 0;
  isCoolingDownMock.mockResolvedValue(false);
  remainingMock.mockResolvedValue(0);
});

/** 真的造一个 AIError——fallback 判的是 instanceof，伪造 name 没用。 */
async function failWith(message: string, code = 'AI_ERROR'): Promise<void> {
  const { AIError } = await import('../../../src/shared/errors.js');
  callModelMock.mockRejectedValue(new AIError(message, 'primary', 'primary-model', code));
}

describe('冷却分级（行为）', () => {
  it('① concurrent limit → 长冷却（300s）', async () => {
    await failWith("HTTP 403: You've reached your concurrent request limit");
    await expect(callWithFallback(base)).rejects.toThrow();
    const cooldown = setCooldownCalls.find((c) => c.sec === 300);
    expect(cooldown, 'congurent limit 应该打 300s 冷却').toBeDefined();
    expect(cooldown!.model).toBe('primary-model');
  });

  it('② 普通 rate limit → 只打短期冷却，不覆盖成 300s', async () => {
    await failWith('HTTP 429: Rate limit reached. Too many requests.', 'AI_RATE_LIMIT');
    await expect(callWithFallback(base)).rejects.toThrow();
    const long = setCooldownCalls.find((c) => c.sec === 300);
    expect(long, '普通限流不该打 300s').toBeUndefined();
  });

  it('③ 普通 rate limit 仍有短期冷却那一次（不变成零冷却）', async () => {
    await failWith('HTTP 429: Rate limit reached. Too many requests.', 'AI_RATE_LIMIT');
    await expect(callWithFallback(base)).rejects.toThrow();
    // 短期冷却是 setCooldown(model) 不带 sec
    const short = setCooldownCalls.find((c) => c.sec === undefined);
    expect(short, '普通限流至少该有短期冷却').toBeDefined();
  });

  it('④ 分级对每个候选 label 都生效（不只 primary）', async () => {
    // getUsage 给了 backups: ['hedge', 'last']，三个 label 都会失败。
    // 分级判据若只写在 primary 分支里，hedge/last 就会回到旧的宽正则。
    await failWith("You've reached your concurrent request limit");
    await expect(callWithFallback(base)).rejects.toThrow();
    const longOnes = setCooldownCalls.filter((c) => c.sec === 300);
    expect(longOnes.length, '每个失败的 label 都该打长冷却').toBeGreaterThanOrEqual(2);
  });

  it('⑤ 非限流错误不触发任何冷却分支', async () => {
    await failWith('HTTP 500: internal server error');
    await expect(callWithFallback(base)).rejects.toThrow();
    const any300 = setCooldownCalls.some((c) => c.sec === 300);
    expect(any300).toBe(false);
  });
});
