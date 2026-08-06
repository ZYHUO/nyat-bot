import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIError } from '../../../src/shared/errors.js';

// 只 mock fallback 依赖的接缝,验证"内容拒绝 → 继续试下一个"的链路行为。
const callModel = vi.fn();
vi.mock('../../../src/ai/provider.js', () => ({ callModel: (...a: unknown[]) => callModel(...a) }));
// mundo 带 per-label timeout/maxTokens 覆盖;其它 label 无。
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: () => ({ label: 'stepfun', backups: ['mundo', 'sub2gpt55'], timeout: 30_000, maxTokens: 3_000 }),
  getLabel: (name: string) => name === 'mundo'
    ? { name, model: 'qwen3.6', endpoint: '', apiKeys: ['k'], timeout: 240_000, maxTokens: 16_000 }
    : { name, model: `${name}-model`, endpoint: '', apiKeys: ['k'] },
}));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 0 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    async setCooldown(): Promise<void> {}
    async recordSuccess(): Promise<void> {}
    async recordFailure(): Promise<boolean> { return false; }
    async isCoolingDown(): Promise<boolean> { return false; }
    async getRemainingSeconds(): Promise<number> { return 0; }
  },
}));

import { callWithFallback } from '../../../src/ai/fallback.js';

function ok(label: string) {
  return { content: '正常回答', tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: `${label}-model`, label, latencyMs: 1 };
}

describe('内容安全拒绝 → 继续试下一个 provider(修:不再一拒就放弃整条链)', () => {
  beforeEach(() => { callModel.mockReset(); });

  it('第一个 provider 内容拒绝 → 换下一个 → 成功返回(不弹兜底)', async () => {
    callModel
      .mockRejectedValueOnce(new AIError('blocked', 'stepfun', 'm', 'AI_CONTENT_REJECTED'))
      .mockResolvedValueOnce(ok('mundo'));
    const r = await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: '翻墙节点推荐' }] });
    expect(r.content).toBe('正常回答');
    expect(r.label).toBe('mundo');
    expect(callModel).toHaveBeenCalledTimes(2); // 关键:没短路,试了第二个(mundo)
  });

  it('全链都内容拒绝 → 最终抛 AI_CONTENT_REJECTED(此时 reply 层才弹兜底=真被拦)', async () => {
    callModel.mockRejectedValue(new AIError('blocked', 'x', 'm', 'AI_CONTENT_REJECTED'));
    await expect(
      callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'AI_CONTENT_REJECTED' });
    expect(callModel).toHaveBeenCalledTimes(3); // stepfun + mundo + sub2gpt55 都试过
  });
});

describe('per-label 超时/maxTokens 覆盖(让 mundo 在回复链里真出力)', () => {
  beforeEach(() => { callModel.mockReset(); });

  it('落到 mundo 时用 mundo 的 timeout(240s)/maxTokens(16000),而非 usage 的 30s/3000', async () => {
    callModel
      .mockRejectedValueOnce(new AIError('blocked', 'stepfun', 'm', 'AI_CONTENT_REJECTED')) // stepfun 拒
      .mockResolvedValueOnce(ok('mundo')); // mundo 出力
    await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: '硬技术问题' }] });
    // 第 2 次调用(mundo)的 opts:timeout=240000, maxTokens=16000
    const mundoOpts = callModel.mock.calls[1]![2] as { timeout: number; maxTokens: number };
    expect(mundoOpts.timeout).toBe(240_000);
    expect(mundoOpts.maxTokens).toBe(16_000);
    // 第 1 次(stepfun,无覆盖)用 usage 的 30s/3000
    const stepfunOpts = callModel.mock.calls[0]![2] as { timeout: number; maxTokens: number };
    expect(stepfunOpts.timeout).toBe(30_000);
    expect(stepfunOpts.maxTokens).toBe(3_000);
  });

  it('调用方设 maxTimeoutMs → mundo 的长超时被上限压到(延迟敏感路径不被 mundo 久拖)', async () => {
    callModel
      .mockRejectedValueOnce(new AIError('blocked', 'stepfun', 'm', 'AI_CONTENT_REJECTED'))
      .mockResolvedValueOnce(ok('mundo'));
    await callWithFallback({ usage: 'reply', maxTimeoutMs: 5_000, messages: [{ role: 'user', content: 'x' }] });
    const mundoOpts = callModel.mock.calls[1]![2] as { timeout: number };
    expect(mundoOpts.timeout).toBe(5_000); // min(240000, 5000)
  });
});
