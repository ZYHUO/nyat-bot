import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ MULTI_AGENT_CHECKER_TIMEOUT_MS: 10000 }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { runFactChecker } from '../../../../src/pipeline/multiagent/fact-checker.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runFactChecker', () => {
  it('无研究员素材 → null,不调 LLM', async () => {
    expect(await runFactChecker({ messageText: 'q', researcherFindings: '' })).toBeNull();
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('LLM 判核查通过 → null', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('(核查通过)'));
    expect(await runFactChecker({ messageText: 'q', researcherFindings: '[TOOL_RESULTS]\n...' })).toBeNull();
  });

  it('LLM 发现可疑 → 返回 [核查员] 块', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('第2条数据来源不明,可疑'));
    const out = await runFactChecker({ messageText: 'q', researcherFindings: '素材' });
    expect(out).toContain('[核查员]');
    expect(out).toContain('第2条数据来源不明');
  });

  it('LLM 抛错 → fail-soft 返回 null', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    expect(await runFactChecker({ messageText: 'q', researcherFindings: '素材' })).toBeNull();
  });
});
