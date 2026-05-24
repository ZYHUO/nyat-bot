import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock env
vi.mock('../../../../src/env.js', () => ({
  env: () => ({
    XAI_API_KEY: process.env['TEST_XAI_API_KEY'],
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

  it('normalizes xAI web_search wrapper output before returning it to the final writer', async () => {
    process.env['TEST_XAI_API_KEY'] = 'xai-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: `<web_search>
Search results for "Cloudflare NET stock 2026 year performance YTD":

1. Title: **Cloudflare (NET) Stock Price History 2019-2026**
   URL: https://stockanalysis.com/stocks/net/history/

2. Title: **Cloudflare Q1 Results Beat Expectations**
   Published: 21 May 2026 01:07:57
   URL: https://finance.yahoo.com/news/net-q1.html
   Cloudflare had climbed over 30% YTD heading into earnings.
</web_search>`,
          }],
        }],
      }),
    }) as unknown as typeof fetch;

    const result = await executeSearch('Cloudflare NET stock 2026 year performance YTD');

    expect(result).toContain('关于"Cloudflare NET stock 2026 year performance YTD"的搜索结果：');
    expect(result).toContain('Cloudflare (NET) Stock Price History 2019-2026');
    expect(result).toContain('Cloudflare Q1 Results Beat Expectations');
    expect(result).toContain('https://stockanalysis.com/stocks/net/history/');
    expect(result).not.toContain('<web_search>');
    expect(result).not.toContain('</web_search>');
    expect(result).not.toContain('Search results for');
  });
});
