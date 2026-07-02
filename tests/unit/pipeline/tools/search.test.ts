import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock env
vi.mock('../../../../src/env.js', () => ({
  env: () => ({
    GEMINI_API_KEY: process.env['TEST_GEMINI_API_KEY'],
    GEMINI_SEARCH_MODEL: 'gemini-test',
    GEMINI_SEARCH_PROXY: undefined,
    XAI_API_KEY: process.env['TEST_XAI_API_KEY'],
    XAI_SEARCH_BASE_URL: 'https://new-api.test/v1',
    XAI_SEARCH_MODEL: 'grok-test',
    SEARXNG_URL: 'http://searxng:8080',
  }),
}));

// Mock logger
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { executeSearch } from '../../../../src/pipeline/tools/search.js';

describe('executeSearch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['TEST_GEMINI_API_KEY'];
    delete process.env['TEST_XAI_API_KEY'];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns formatted results on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'Result 1', content: 'Summary 1', url: 'https://example.com/1' },
          { title: 'Result 2', content: '<b>Summary</b> 2', url: 'https://example.com/2' },
        ],
      }),
    }) as unknown as typeof fetch;

    const result = await executeSearch('test query');
    expect(result).toContain('关于"test query"的搜索结果：');
    expect(result).toContain('Result 1');
    expect(result).toContain('Summary 1');
    expect(result).toContain('Result 2');
    // HTML tags should be stripped
    expect(result).not.toContain('<b>');
  });

  it('handles empty results', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }) as unknown as typeof fetch;

    const result = await executeSearch('nonexistent query');
    expect(result).toContain('没有找到');
  });

  it('handles API errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const result = await executeSearch('fail query');
    expect(result).toContain('搜索失败');
    expect(result).toContain('500');
  });

  it('handles network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

    const result = await executeSearch('fail query');
    expect(result).toContain('搜索失败');
    expect(result).toContain('Network error');
  });

  it('limits results to MAX_RESULTS (5)', async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`,
      content: `Summary ${i}`,
      url: `https://example.com/${i}`,
    }));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results }),
    }) as unknown as typeof fetch;

    const result = await executeSearch('many results');
    // Should have exactly 5 results (Result 0 through Result 4)
    expect(result).toContain('Result 0');
    expect(result).toContain('Result 4');
    expect(result).not.toContain('Result 5');
  });

  it('returns Gemini grounding content + 来源 list (primary route)', async () => {
    process.env['TEST_GEMINI_API_KEY'] = 'gemini-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: 'Cloudflare (NET) 2026 年至今涨超 30%,Q1 财报超预期。' }],
          },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'Cloudflare (NET) Stock Price History 2019-2026', uri: 'https://stockanalysis.com/stocks/net/history/' } },
              { web: { title: 'Cloudflare Q1 Results Beat Expectations', uri: 'https://finance.yahoo.com/news/net-q1.html' } },
            ],
          },
        }],
      }),
    }) as unknown as typeof fetch;

    const result = await executeSearch('Cloudflare NET stock 2026 year performance YTD');

    expect(result).toContain('Cloudflare (NET) 2026');
    expect(result).toContain('来源');
    expect(result).toContain('Cloudflare (NET) Stock Price History 2019-2026');
    expect(result).toContain('Cloudflare Q1 Results Beat Expectations');
  });
});
