import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(async ({ messages }: { messages: { content: string }[] }) => {
    const p = messages[0]?.content ?? '';
    if (p.includes('我是正确答案')) return { content: '0.9' };
    if (p.includes('乱编的')) return { content: '0.1' };
    return { content: '0.5' };
  }),
}));
vi.mock('../../../src/env.js', () => ({ env: () => ({ BEST_OF_N_BASE: 4 }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { estimateDifficulty, sampleCountFor, verifyReplyQuality, pickBestOfN, bestOfNBase } = await import('../../../src/agent/best-of-n.js');

describe('best-of-n', () => {
  it('estimates difficulty from length and keywords', () => {
    expect(estimateDifficulty('早上好', false)).toBe(1);
    expect(estimateDifficulty('帮我分析这段代码的原理和实现方案', true)).toBe(3);
    expect(estimateDifficulty('今天过得怎么样呀', true)).toBe(1);
  });

  it('scales sample count by difficulty', () => {
    expect(sampleCountFor(1, 4)).toBe(1);
    expect(sampleCountFor(2, 4)).toBeGreaterThanOrEqual(2);
    expect(sampleCountFor(3, 4)).toBeGreaterThanOrEqual(4);
  });

  it('verifier scores replies', async () => {
    expect(await verifyReplyQuality({ reply: '我是正确答案' })).toBe(0.9);
    expect(await verifyReplyQuality({ reply: '乱编的' })).toBe(0.1);
  });

  it('pickBestOfN chooses the highest-scoring candidate', async () => {
    const { best, score } = await pickBestOfN(['乱编的', '我是正确答案', '中间']);
    expect(best).toBe('我是正确答案');
    expect(score).toBe(0.9);
  });

  it('single candidate passes through', async () => {
    const { best } = await pickBestOfN(['only']);
    expect(best).toBe('only');
  });

  it('bestOfNBase reads env', () => {
    expect(bestOfNBase()).toBe(4);
  });
});
