import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/env.js', () => ({
  env: () => ({ GEMINI_API_KEY: 'test-gemini-key', GEMINI_SEARCH_MODEL: 'gemini-2.5-flash-lite' }),
}));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { executeSearch } from '../../../../src/pipeline/tools/search.js';

describe('executeSearch via Gemini grounding', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns synthesized answer + deduped sources, hitting the grounding endpoint', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url; capturedBody = JSON.parse(init.body as string);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: '英伟达最新旗舰是 RTX 5090。' }] },
            groundingMetadata: {
              webSearchQueries: ['nvidia flagship 2026'],
              groundingChunks: [
                { web: { title: 'nvidia.com', uri: 'https://x/1' } },
                { web: { title: '163.com', uri: 'https://x/2' } },
                { web: { title: 'nvidia.com', uri: 'https://x/3' } }, // dup title
              ],
            },
          }],
        }),
      });
    }) as unknown as typeof fetch;

    const out = await executeSearch('英伟达最新旗舰显卡');

    expect(capturedUrl).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    expect(capturedUrl).toContain('key=test-gemini-key');
    expect(capturedBody.tools).toEqual([{ google_search: {} }]);
    expect(out).toContain('RTX 5090');
    expect(out).toContain('来源：');
    expect(out).toContain('nvidia.com');
    // dedup: nvidia.com appears once in sources
    expect(out.match(/nvidia\.com/g)!.length).toBe(1);
  });

  it('returns a clean no-result line when grounding yields empty text', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [] } }] }),
    }) as unknown as typeof fetch;
    const out = await executeSearch('asdfqwer');
    expect(out).toContain('没有找到');
  });

  it('falls back (no throw) when the grounding API errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => 'quota exceeded',
    }) as unknown as typeof fetch;
    // GEMINI fails → falls through; no xAI/searxng configured → DDG path also uses fetch(429) →
    // returns a string, never throws.
    const out = await executeSearch('test');
    expect(typeof out).toBe('string');
  });
});
