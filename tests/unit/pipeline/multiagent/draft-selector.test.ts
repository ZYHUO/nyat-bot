import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn() }));
vi.mock('../../../../src/env.js', () => ({ env: () => ({ WRITER_SELECTOR_TIMEOUT_MS: 6000 }) }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { selectBestDraft } from '../../../../src/pipeline/multiagent/draft-selector.js';
import { callWithFallback } from '../../../../src/ai/fallback.js';

const ok = (content: string) => ({ content, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('selectBestDraft (Best-of-N 选择器)', () => {
  it('单稿 → 直接返回 0,不调 LLM', async () => {
    expect(await selectBestDraft({ messageText: 'q', drafts: ['only'] })).toBe(0);
    expect(callWithFallback).not.toHaveBeenCalled();
  });

  it('解析编号(1-based)→ 索引', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('2'));
    expect(await selectBestDraft({ messageText: 'q', drafts: ['a', 'b', 'c'] })).toBe(1);
  });

  it('编号越界 → 回退 0', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('9'));
    expect(await selectBestDraft({ messageText: 'q', drafts: ['a', 'b'] })).toBe(0);
  });

  it('无数字 → 回退 0', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok('都不行'));
    expect(await selectBestDraft({ messageText: 'q', drafts: ['a', 'b'] })).toBe(0);
  });

  it('LLM 抛错 → 回退 0', async () => {
    (callWithFallback as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    expect(await selectBestDraft({ messageText: 'q', drafts: ['a', 'b'] })).toBe(0);
  });
});
