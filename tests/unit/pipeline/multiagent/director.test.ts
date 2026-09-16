import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ MULTI_AGENT_DIRECTOR_TIMEOUT_MS: 5000 }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runDirector } from '../../../../src/pipeline/multiagent/director.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDirector (导演定调)', () => {
  it('有产出 → 带 [导演定调] 前缀', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('用拆台语气接他吹牛'));
    const out = await runDirector({ messageText: '我今天赚了一万', context: 'CTX' });
    expect(out).toContain('[导演定调]');
    expect(out).toContain('拆台');
  });

  it('空产出 → null', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok(''));
    expect(await runDirector({ messageText: 'q', context: 'c' })).toBeNull();
  });

  it('LLM 抛错 → null(fail-soft)', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    expect(await runDirector({ messageText: 'q', context: 'c' })).toBeNull();
  });
});
