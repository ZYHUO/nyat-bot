import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIError } from '../../../src/shared/errors.js';

// 只 mock fallback 依赖的接缝,验证"内容拒绝 → 继续试下一个"的链路行为。
const callModel = vi.fn();
vi.mock('../../../src/ai/provider.js', () => ({ callModel: (...a: unknown[]) => callModel(...a) }));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: () => ({ label: 'stepfun', backups: ['sub2gpt55'], timeout: 30_000 }),
  getLabel: (name: string) => ({ name, model: `${name}-model`, endpoint: '', apiKeys: ['k'] }),
}));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 0 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    async setCooldown(): Promise<void> {}
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
      .mockResolvedValueOnce(ok('sub2gpt55'));
    const r = await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: '翻墙节点推荐' }] });
    expect(r.content).toBe('正常回答');
    expect(r.label).toBe('sub2gpt55');
    expect(callModel).toHaveBeenCalledTimes(2); // 关键:没短路,试了第二个
  });

  it('全链都内容拒绝 → 最终抛 AI_CONTENT_REJECTED(此时 reply 层才弹兜底=真被拦)', async () => {
    callModel.mockRejectedValue(new AIError('blocked', 'x', 'm', 'AI_CONTENT_REJECTED'));
    await expect(
      callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'AI_CONTENT_REJECTED' });
    expect(callModel).toHaveBeenCalledTimes(2); // label + 1 backup 都试过
  });
});
