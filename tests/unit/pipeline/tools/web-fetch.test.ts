import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.fn(() => ({
  FETCH_GATEWAY_URL: undefined as string | undefined,
  FETCH_WORKER_URL: undefined as string | undefined,
  NODESEEK_READER_URLS: undefined as string | undefined,
  WEB_FETCH_USER_AGENT: 'XXB-WebFetch/1.0',
}));

vi.mock('../../../../src/env.js', () => ({
  env: () => mockEnv(),
}));

vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockFetchUrlPinned = vi.fn();

vi.mock('../../../../src/pipeline/tools/ssrf.js', () => ({
  assertUrlSsrfSafe: vi.fn(),
  fetchUrlPinned: (...args: unknown[]) => mockFetchUrlPinned(...args),
}));

import { executeFetch } from '../../../../src/pipeline/tools/web-fetch.js';

describe('executeFetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.mockReturnValue({
      FETCH_GATEWAY_URL: undefined,
      FETCH_WORKER_URL: undefined,
      NODESEEK_READER_URLS: undefined,
      WEB_FETCH_USER_AGENT: 'XXB-WebFetch/1.0',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('tries the Cloudflare fallback when a pinned fetch returns a challenge page', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 403,
      headers: {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body>challenge</body></html>',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'NodeSeek latest posts content' }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8900/fetch?url=https%3A%2F%2Fwww.nodeseek.com%2F',
      expect.any(Object),
    );
    expect(result).toContain('NodeSeek latest posts content');
    expect(result).not.toContain('状态码 403');
  });

  it('returns a clear Cloudflare failure when fallback cannot bypass the challenge', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 403,
      headers: {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body>challenge</body></html>',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'all methods failed' }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(result).toContain('Cloudflare 验证');
    expect(result).not.toContain('目标网页返回状态码 403');
  });

  it('treats alternate Cloudflare challenge wording as a challenge', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 403,
      headers: {
        server: 'cloudflare',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Attention Required! | Cloudflare</title></head><body>Enable JavaScript and cookies to continue <div class="cf-turnstile"></div></body></html>',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'all methods failed' }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://example.com/');

    expect(result).toContain('Cloudflare 验证');
    expect(result).not.toContain('目标网页返回状态码 403');
  });

  it('treats non-403 Cloudflare challenge responses as a challenge', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 503,
      headers: {
        server: 'cloudflare',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'all methods failed' }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://example.com/');

    expect(result).toContain('Cloudflare 验证');
    expect(result).not.toContain('目标网页返回状态码 503');
  });

  it('uses a same-domain public reader fallback for nodeseek.com Cloudflare challenges', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 403,
      headers: {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body>challenge</body></html>',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'all methods failed' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/',
          '',
          'Markdown Content:',
          '# NodeSeek',
          '最新帖子内容',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('nodeseek.cc'),
      expect.anything(),
    );
    expect(result).toContain('NodeSeek');
    expect(result).toContain('最新帖子内容');
    expect(result).not.toContain('Cloudflare 验证');
  });

  it('uses the nodeseek.com public reader before direct fetch attempts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: NodeSeek',
        '',
        'URL Source: http://www.nodeseek.com/',
        '',
        'Markdown Content:',
        '*   [![Image 2: user](http://www.nodeseek.com/avatar/1.png)](http://www.nodeseek.com/space/1)[前置 reader 帖子](http://www.nodeseek.com/post-11-1) [alice](http://www.nodeseek.com/space/1)11 2[bob](http://www.nodeseek.com/space/2)[1min ago](http://www.nodeseek.com/post-11-1#2)[技术](http://www.nodeseek.com/categories/tech)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek 主题列表');
    expect(result).toContain('前置 reader 帖子');
    expect(result).toContain('链接: https://www.nodeseek.com/post-11-1');
  });

  it('tries alternate nodeseek.com reader urls before direct fetch attempts', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'direct content should not be used',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: https://www.nodeseek.com/',
          '',
          'Markdown Content:',
          '*   [备用 reader 帖子](https://www.nodeseek.com/post-12-1) [alice](https://www.nodeseek.com/space/1)11 2[bob](https://www.nodeseek.com/space/2)[1min ago](https://www.nodeseek.com/post-12-1#2)[技术](https://www.nodeseek.com/categories/tech)',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/https://www.nodeseek.com/',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('nodeseek.cc'),
      expect.anything(),
    );
    expect(result).toContain('NodeSeek 主题列表');
    expect(result).toContain('备用 reader 帖子');
    expect(result).not.toContain('direct content should not be used');
  });

  it('tries nodeseek.com category page-one reader urls before direct fetch attempts', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'direct category content should not be used',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Just a moment...',
          '',
          'URL Source: https://www.nodeseek.com/categories/tech',
          '',
          'Markdown Content:',
          'Enable JavaScript and cookies to continue',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: 技术版块',
          '',
          'URL Source: http://www.nodeseek.com/categories/tech/page-1',
          '',
          'Markdown Content:',
          '*   [分类备用帖](http://www.nodeseek.com/post-13-1) [alice](http://www.nodeseek.com/space/1)11 2[bob](http://www.nodeseek.com/space/2)[1min ago](http://www.nodeseek.com/post-13-1#2)[技术](http://www.nodeseek.com/categories/tech)',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/categories/tech');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/categories/tech',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/https://www.nodeseek.com/categories/tech',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/categories/tech/page-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek 主题列表');
    expect(result).toContain('分类备用帖');
    expect(result).not.toContain('Enable JavaScript and cookies');
    expect(result).not.toContain('direct category content should not be used');
  });

  it('tries nodeseek.com list alias page-one reader urls before direct fetch attempts', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'direct alias content should not be used',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Just a moment...',
          '',
          'URL Source: http://www.nodeseek.com/new',
          '',
          'Warning: Target URL returned error 403: Forbidden',
          '',
          'Markdown Content:',
          'Performing security verification',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Error',
          '',
          'URL Source: https://www.nodeseek.com/new',
          '',
          'Warning: Target URL returned error 404: Not Found',
          '',
          'Markdown Content:',
          '# Error',
          'Cannot GET /new',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/page-1',
          '',
          'Markdown Content:',
          '*   [别名备用帖](http://www.nodeseek.com/post-16-1) [alice](http://www.nodeseek.com/space/1)11 2[bob](http://www.nodeseek.com/space/2)[1min ago](http://www.nodeseek.com/post-16-1#2)[日常](http://www.nodeseek.com/categories/daily)',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/new');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/new',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/https://www.nodeseek.com/new',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/page-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('nodeseek.cc'),
      expect.anything(),
    );
    expect(result).toContain('NodeSeek 主题列表');
    expect(result).toContain('别名备用帖');
    expect(result).not.toContain('Cannot GET /new');
    expect(result).not.toContain('direct alias content should not be used');
  });

  it('filters nodeseek.com category reader rows to the requested category', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: 技术版块',
        '',
        'URL Source: http://www.nodeseek.com/categories/tech',
        '',
        'Markdown Content:',
        '*   [置顶日常帖](http://www.nodeseek.com/post-14-1) [alice](http://www.nodeseek.com/space/1)11 2[bob](http://www.nodeseek.com/space/2)[1min ago](http://www.nodeseek.com/post-14-1#2)[日常](http://www.nodeseek.com/categories/daily)',
        '*   [目标技术帖](http://www.nodeseek.com/post-15-1) [carol](http://www.nodeseek.com/space/3)11 2[dave](http://www.nodeseek.com/space/4)[1min ago](http://www.nodeseek.com/post-15-1#2)[技术](http://www.nodeseek.com/categories/tech)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/categories/tech/page-1');

    expect(result).toContain('目标技术帖');
    expect(result).toContain('分类: 技术');
    expect(result).not.toContain('置顶日常帖');
    expect(result).not.toContain('分类: 日常');
  });

  it('does not summarize nodeseek.com public reader error pages', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 404,
      headers: { 'content-type': 'text/plain' },
      body: 'not found',
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: Error',
        '',
        'URL Source: http://www.nodeseek.com/new',
        '',
        'Warning: Target URL returned error 404: Not Found',
        '',
        'Markdown Content:',
        '# Error',
        'Cannot GET /new',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/new');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/new',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockFetchUrlPinned).toHaveBeenCalled();
    expect(result).toContain('抓取失败');
    expect(result).not.toContain('Cannot GET /new');
    expect(result).not.toContain('标题: Error');
  });

  it('ignores Cloudflare challenge pages returned by the local fallback and continues to the reader', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 403,
      headers: {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body>challenge</body></html>',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: '<html><head><title>Just a moment...</title></head><body>Performing security verification</body></html>',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/',
          '',
          'Markdown Content:',
          '# reader fallback after local challenge',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(result).toContain('reader fallback after local challenge');
    expect(result).not.toContain('Just a moment');
    expect(result).not.toContain('Performing security verification');
  });

  it('does not summarize alternate direct 200 Cloudflare challenge pages', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 200,
      headers: {
        server: 'cloudflare',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Attention Required! | Cloudflare</title></head><body>Enable JavaScript and cookies to continue <input name="cf-turnstile-response"></body></html>',
    });

    const result = await executeFetch('https://example.com/');

    expect(result).toContain('Cloudflare 验证');
    expect(result).not.toContain('Enable JavaScript and cookies');
  });

  it('cleans nodeseek.com reader output down to topic rows before truncation', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: NodeSeek',
        '',
        'URL Source: http://www.nodeseek.com/',
        '',
        'Markdown Content:',
        '# NodeSeek',
        '*   [日常](http://www.nodeseek.com/categories/daily)',
        '*   [技术](http://www.nodeseek.com/categories/tech)',
        '*   [![Image 2: user](http://www.nodeseek.com/avatar/1.png)](http://www.nodeseek.com/space/1)[第一条帖子](http://www.nodeseek.com/post-1-1) [alice](http://www.nodeseek.com/space/1)113 5[bob](http://www.nodeseek.com/space/2)[14s ago](http://www.nodeseek.com/post-1-1#5)[日常](http://www.nodeseek.com/categories/daily)',
        '*   [![Image 4: reply](http://www.nodeseek.com/avatar/4.png)](http://www.nodeseek.com/space/4)[35min ago](http://www.nodeseek.com/post-1-6#58)[技术](http://www.nodeseek.com/categories/tech)',
        '*   [![Image 3: user](http://www.nodeseek.com/avatar/3.png)](http://www.nodeseek.com/space/3)[第二条帖子](http://www.nodeseek.com/post-2-1) [carol](http://www.nodeseek.com/space/3)65 9[dave](http://www.nodeseek.com/space/4)[31s ago](http://www.nodeseek.com/post-2-1#9)[技术](http://www.nodeseek.com/categories/tech)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(result).toContain('NodeSeek 主题列表');
    expect(result).toContain('第一条帖子');
    expect(result).toContain('作者: alice');
    expect(result).toContain('分类: 日常');
    expect(result).toContain('链接: https://www.nodeseek.com/post-1-1');
    expect(result).toContain('第二条帖子');
    expect(result).not.toContain('链接: http://www.nodeseek.com/post-1-1');
    expect(result).not.toContain('35min ago');
    expect(result).not.toContain('所有版块');
    expect(result).not.toContain('Image 2');
  });

  it('parses nodeseek.com reader topic rows when links are https', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: NodeSeek',
        '',
        'URL Source: https://www.nodeseek.com/',
        '',
        'Markdown Content:',
        '*   [HTTPS 帖子](https://www.nodeseek.com/post-3-1) [erin](https://www.nodeseek.com/space/3)12 1[frank](https://www.nodeseek.com/space/4)[1min ago](https://www.nodeseek.com/post-3-1#1)[技术](https://www.nodeseek.com/categories/tech)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(result).toContain('HTTPS 帖子');
    expect(result).toContain('作者: erin');
    expect(result).toContain('分类: 技术');
    expect(result).toContain('链接: https://www.nodeseek.com/post-3-1');
  });

  it('does not treat nodeseek.com same-page timestamp links as topic titles', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: 测评版块',
        '',
        'URL Source: http://www.nodeseek.com/categories/review',
        '',
        'Markdown Content:',
        '*   [![Image 11: 暴躁青年](http://www.nodeseek.com/avatar/55077.png)](http://www.nodeseek.com/space/55077)[[NQ]TOT K Lite 1C 512M](http://www.nodeseek.com/post-743170-1) [暴躁青年](http://www.nodeseek.com/space/55077)32 0[暴躁青年](http://www.nodeseek.com/space/55077)[1h 39min ago](http://www.nodeseek.com/post-743170-1)[测评](http://www.nodeseek.com/categories/review)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/categories/review');

    expect(result).toContain('NodeSeek 主题列表');
    expect(result).toContain('[NQ]TOT K Lite 1C 512M');
    expect(result).toContain('作者: 暴躁青年');
    expect(result).toContain('分类: 测评');
    expect(result).toContain('链接: https://www.nodeseek.com/post-743170-1');
    expect(result).not.toContain('1. 1h 39min ago');
  });

  it('labels nodeseek.com award pages as featured topics', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: NodeSeek-精品贴',
        '',
        'URL Source: http://www.nodeseek.com/award',
        '',
        'Markdown Content:',
        '# NodeSeek-精品贴',
        '*   [![Image 2: shuai](http://www.nodeseek.com/avatar/4706.png)](http://www.nodeseek.com/space/4706)[【NodeWarden】cloudflare workers版bitwarden服务端](http://www.nodeseek.com/post-606589-1)[](http://www.nodeseek.com/award "推荐阅读") [shuai](http://www.nodeseek.com/space/4706)11249 164[ifso](http://www.nodeseek.com/space/35827)[3h 59min ago](http://www.nodeseek.com/post-606589-17#164)[技术](http://www.nodeseek.com/categories/tech)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/award');

    expect(result).toContain('NodeSeek 精品贴');
    expect(result).not.toContain('标题: NodeSeek 主题列表');
    expect(result).toContain('【NodeWarden】cloudflare workers版bitwarden服务端');
    expect(result).toContain('作者: shuai');
    expect(result).toContain('分类: 技术');
  });

  it('formats nodeseek.com RSS reader output as a structured feed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: ',
        '',
        'URL Source: http://www.nodeseek.com/rss.xml',
        '',
        'Markdown Content:',
        '### [](https://www.nodeseek.com/post-743180-1)',
        '',
        '[https://www.nodeseek.com/post-743180-1](https://www.nodeseek.com/post-743180-1)',
        '',
        'Fri, 22 May 2026 21:40:16 GMT',
        '',
        '### [](https://www.nodeseek.com/post-743178-1)',
        '',
        '[https://www.nodeseek.com/post-743178-1](https://www.nodeseek.com/post-743178-1)',
        '',
        'Fri, 22 May 2026 21:26:24 GMT',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/rss.xml');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/rss.xml',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek RSS');
    expect(result).toContain('1. https://www.nodeseek.com/post-743180-1');
    expect(result).toContain('时间: Fri, 22 May 2026 21:40:16 GMT');
    expect(result).toContain('2. https://www.nodeseek.com/post-743178-1');
    expect(result).not.toContain('标题: N/A');
    expect(result).not.toContain('状态: 已截断');
  });

  it('formats nodeseek.com sitemap reader output as a structured sitemap index', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: Sitemap Index',
        '',
        'URL Source: http://www.nodeseek.com/sitemap.xml',
        '',
        'Published Time: Sun, 17 May 2026 20:01:07 GMT',
        '',
        'Markdown Content:',
        '# Sitemap Index',
        '',
        '[https://www.nodeseek.com/sitemap-73.xml](https://www.nodeseek.com/sitemap-73.xml)',
        '',
        '2026-05-17T20:00:53.000Z',
        '',
        '[https://www.nodeseek.com/sitemap-72.xml](https://www.nodeseek.com/sitemap-72.xml)',
        '',
        '2026-05-14T07:52:33.000Z',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/sitemap.xml');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/sitemap.xml',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek Sitemap');
    expect(result).toContain('1. https://www.nodeseek.com/sitemap-73.xml');
    expect(result).toContain('更新时间: 2026-05-17T20:00:53.000Z');
    expect(result).toContain('2. https://www.nodeseek.com/sitemap-72.xml');
    expect(result).not.toContain('标题: N/A');
    expect(result).not.toContain('状态: 已截断');
  });

  it('formats nodeseek.com sitemap page reader output as structured topic links', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: Sitemap',
        '',
        'URL Source: http://www.nodeseek.com/sitemap-73.xml',
        '',
        'Published Time: Sun, 17 May 2026 20:01:14 GMT',
        '',
        'Markdown Content:',
        '# Sitemap',
        '',
        '[https://www.nodeseek.com/post-735070-1](https://www.nodeseek.com/post-735070-1)',
        '',
        '2026-05-17T20:00:53.000Z',
        '',
        '[https://www.nodeseek.com/post-735069-1](https://www.nodeseek.com/post-735069-1)',
        '',
        '2026-05-17T19:48:56.000Z',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/sitemap-73.xml');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/sitemap-73.xml',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek Sitemap');
    expect(result).toContain('1. https://www.nodeseek.com/post-735070-1');
    expect(result).toContain('更新时间: 2026-05-17T20:00:53.000Z');
    expect(result).toContain('2. https://www.nodeseek.com/post-735069-1');
    expect(result).not.toContain('标题: N/A');
    expect(result).not.toContain('状态: 已截断');
  });

  it('uses nodeseek.com page-one reader output as a categories index fallback', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Error',
          '',
          'URL Source: http://www.nodeseek.com/categories',
          '',
          'Warning: Target URL returned error 404: Not Found',
          '',
          'Markdown Content:',
          '# Error',
          'Cannot GET /categories',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: www.nodeseek.com',
          '',
          'URL Source: https://www.nodeseek.com/categories',
          '',
          'Warning: Target URL returned error 404: Not Found',
          '',
          'Markdown Content:',
          '## This www.nodeseek.com page can’t be found',
          'HTTP ERROR 404',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/page-1',
          '',
          'Markdown Content:',
          '#### 所有版块',
          '',
          '*   [日常](http://www.nodeseek.com/categories/daily)',
          '*   [技术](http://www.nodeseek.com/categories/tech)',
          '*   [情报](http://www.nodeseek.com/categories/info)',
          '',
          '[新评论](http://www.nodeseek.com/page-1)[新帖子](http://www.nodeseek.com/page-1)',
          '',
          '*   [首页帖子](http://www.nodeseek.com/post-1-1) [alice](http://www.nodeseek.com/space/1)1 1[bob](http://www.nodeseek.com/space/2)[1min ago](http://www.nodeseek.com/post-1-1#1)[日常](http://www.nodeseek.com/categories/daily)',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/categories');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/categories',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/page-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek 版块列表');
    expect(result).toContain('1. 日常');
    expect(result).toContain('链接: https://www.nodeseek.com/categories/daily');
    expect(result).toContain('2. 技术');
    expect(result).not.toContain('首页帖子');
    expect(result).not.toContain('Cannot GET /categories');
  });

  it('cleans nodeseek.com about reader output down to the public about sections', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: 关于NodeSeek网站，一些你可能想知道的?',
        '',
        'URL Source: http://www.nodeseek.com/about',
        '',
        'Markdown Content:',
        '# 关于NodeSeek网站，一些你可能想知道的?',
        '**[![Image 1: logo](http://www.nodeseek.com/static/image/favicon/android-chrome-192x192.png)NodeSeek beta](http://www.nodeseek.com/)**',
        '*   [日常](http://www.nodeseek.com/categories/daily)',
        '[search for post](javascript:void(0))',
        '#### 所有版块',
        '*   [技术](http://www.nodeseek.com/categories/tech)',
        '# [关于NodeSeek网站，一些你可能想知道的?](http://www.nodeseek.com/post-68-1)',
        '[Lloyd](http://www.nodeseek.com/space/1)楼主 服主 管理',
        '## 论坛的初衷和愿景',
        'NodeSeek旨在为主机爱好者打造高品质社区，传递行业新闻，分享技术心得。',
        '## 论坛人员组成概况',
        '截止发帖时间（2022-12-03），共有注册用户174人。',
        '## 目前的管理团队',
        '*   [酒神](http://www.nodeseek.com/space/9#/general)',
        '*   [zudaz](http://www.nodeseek.com/space/244#/general)',
        '0',
        '0',
        '1[2](http://www.nodeseek.com/post-68-2)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/about');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/about',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek 关于本站');
    expect(result).toContain('论坛的初衷和愿景');
    expect(result).toContain('NodeSeek旨在为主机爱好者打造高品质社区');
    expect(result).toContain('论坛人员组成概况');
    expect(result).toContain('目前的管理团队');
    expect(result).not.toContain('所有版块');
    expect(result).not.toContain('search for post');
    expect(result).not.toContain('状态: 已截断');
  });

  it('cleans nodeseek.com terms reader output down to terms sections', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: 隐私协议和服务条款',
        '',
        'URL Source: http://www.nodeseek.com/termsofservice',
        '',
        'Markdown Content:',
        '## [隐私协议和服务条款](https://www.nodeseek.com/post-1-1) 只读',
        '[![Image 1: Lloyd](https://www.nodeseek.com/avatar/1.png)](https://www.nodeseek.com/space/1 "Lloyd")',
        '1276days ago edited 1276days ago in [Dev](https://www.nodeseek.com/categories/dev)',
        '## 本网站服务协议',
        '最新版本生效日期：2022-11-24',
        '## 定义和说明',
        '《本网站服务协议》（以下简称“本协议”）是用户与本网站之间的协议。',
        '*   本平台：https://www.nodeseek.com；',
        '## 账户的注册、使用及注销',
        '### 注册',
        '您有权选择合法的字符组合作为自己的账号。',
        '### 使用',
        '您的账号仅限于您本人使用。',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/termsofservice');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/termsofservice',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('NodeSeek 隐私协议和服务条款');
    expect(result).toContain('本网站服务协议');
    expect(result).toContain('最新版本生效日期：2022-11-24');
    expect(result).toContain('定义和说明');
    expect(result).toContain('账户的注册、使用及注销');
    expect(result).not.toContain('Image 1');
    expect(result).not.toContain('状态: 已截断');
  });

  it('cleans nodeseek.com reader output for user space pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: NodeSeek-用户空间',
        '',
        'URL Source: http://www.nodeseek.com/space/1',
        '',
        'Markdown Content:',
        '# Lloyd的用户空间',
        '**[![Image 1: logo](http://www.nodeseek.com/static/image/favicon/android-chrome-192x192.png)NodeSeek beta](http://www.nodeseek.com/)**',
        '*   [日常](http://www.nodeseek.com/categories/daily)',
        '[search for post](javascript:void(0))',
        '![Image 2: avatar of user](http://www.nodeseek.com/avatar/1.png)',
        '# Lloyd 服主 管理',
        '本论坛的创建者',
        '[概况](http://www.nodeseek.com/space/1#/general)[主题帖](http://www.nodeseek.com/space/1#/discussions)[评论](http://www.nodeseek.com/space/1#/comments)',
        '加入天数',
        ' 1277 ',
        '等级',
        ' 6 ',
        '鸡腿数目',
        ' 7482 ',
        '[主题帖数 26](http://www.nodeseek.com/space/1#/discussions)[评论数目 90](http://www.nodeseek.com/space/1#/comments)',
        '没有找到readme 🙄',
        '相关网站',
        '[* LowEndTalk](https://lowendtalk.com/)[* HostLoc](https://hostloc.com/)',
        '站内导航',
        '[* 关于本站](http://www.nodeseek.com/about)',
        '商业推广',
        '[* Premium Provider](http://www.nodeseek.com/post-6800-1)',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/space/1');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://www.nodeseek.com/space/1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('nodeseek.cc'),
      expect.anything(),
    );
    expect(result).toContain('NodeSeek 用户空间');
    expect(result).toContain('用户: Lloyd');
    expect(result).toContain('身份: 服主 管理');
    expect(result).toContain('简介: 本论坛的创建者');
    expect(result).toContain('加入天数: 1277');
    expect(result).toContain('等级: 6');
    expect(result).toContain('鸡腿: 7482');
    expect(result).toContain('主题: 26');
    expect(result).toContain('评论: 90');
    expect(result).toContain('相关网站: LowEndTalk, HostLoc');
    expect(result).not.toContain('站内导航');
    expect(result).not.toContain('商业推广');
    expect(result).not.toContain('Image 2');
  });

  it('cleans nodeseek.com reader output for topic detail pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: 第一条帖子',
        '',
        'URL Source: http://www.nodeseek.com/post-1-1',
        '',
        'Markdown Content:',
        '#### 所有版块',
        '*   [日常](https://www.nodeseek.com/categories/daily)',
        '## [第一条帖子](https://www.nodeseek.com/post-1-1)',
        '[alice](https://www.nodeseek.com/space/1)楼主',
        '16min ago',
        'in [日常](https://www.nodeseek.com/categories/daily)',
        '[#0](http://www.nodeseek.com/post-1-1#0)',
        '这是主帖正文。',
        '0',
        '0',
        '*   [![Image 2: bob](https://www.nodeseek.com/avatar/2.png)](https://www.nodeseek.com/space/2 "bob")',
        '[bob](https://www.nodeseek.com/space/2)',
        '15min ago [#1](http://www.nodeseek.com/post-1-1#1)',
        '这是第一条回复。 [登录](https://www.nodeseek.com/signin) 或者 [注册](https://www.nodeseek.com/signup) 后评论.',
        '#### 你好啊，陌生人!',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/post-1-1');

    expect(result).toContain('NodeSeek 主题详情');
    expect(result).toContain('主题: 第一条帖子');
    expect(result).toContain('作者: alice');
    expect(result).toContain('分类: 日常');
    expect(result).toContain('正文: 这是主帖正文。');
    expect(result).toContain('bob: 这是第一条回复。');
    expect(result).not.toContain('登录 或者 注册');
    expect(result).not.toContain('陌生人');
    expect(result).not.toContain('所有版块');
    expect(result).not.toContain('Image 2');
  });

  it('parses nodeseek.com topic detail when reply anchors are https', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: HTTPS 详情',
        '',
        'URL Source: https://www.nodeseek.com/post-3-1',
        '',
        'Markdown Content:',
        '## [HTTPS 详情](https://www.nodeseek.com/post-3-1)',
        '[erin](http://www.nodeseek.com/space/3)楼主',
        'in [技术](https://www.nodeseek.com/categories/tech)',
        '[#0](https://www.nodeseek.com/post-3-1#0)',
        '主帖正文。',
        '[frank](http://www.nodeseek.com/space/4)',
        '1min ago [#1](https://www.nodeseek.com/post-3-1#1)',
        '回复正文。',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/post-3-1');

    expect(result).toContain('主题: HTTPS 详情');
    expect(result).toContain('作者: erin');
    expect(result).toContain('正文: 主帖正文。');
    expect(result).toContain('frank: 回复正文。');
  });

  it('cleans nodeseek.com reader output for later topic pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'Title: Later page title',
        '',
        'URL Source: http://www.nodeseek.com/post-606589-17',
        '',
        'Markdown Content:',
        '# Later page title',
        '*   [日常](http://www.nodeseek.com/categories/daily)',
        '# [Later page title](http://www.nodeseek.com/post-606589-1)',
        '[](http://www.nodeseek.com/post-606589-16)[16](http://www.nodeseek.com/post-606589-16)17',
        '*   [![Image 2: alice](http://www.nodeseek.com/avatar/1.png)](http://www.nodeseek.com/space/1 "alice") [alice](http://www.nodeseek.com/space/1) 53days ago [#161](http://www.nodeseek.com/post-606589-17#161)',
        '第一页之后的回复正文。',
        '0 0 0',
        '*   [![Image 3: bob](http://www.nodeseek.com/avatar/2.png)](http://www.nodeseek.com/space/2 "bob") [bob](http://www.nodeseek.com/space/2) 1h ago [#164](http://www.nodeseek.com/post-606589-17#164)',
        '最后一条回复。',
        '[](http://www.nodeseek.com/post-606589-16)[1..](http://www.nodeseek.com/post-606589-1)[13](http://www.nodeseek.com/post-606589-13)[14](http://www.nodeseek.com/post-606589-14)[15](http://www.nodeseek.com/post-606589-15)[16](http://www.nodeseek.com/post-606589-16)17',
        '0 0 0',
        '[登录](http://www.nodeseek.com/signIn.html) 或者 [注册](http://www.nodeseek.com/register.html) 后评论.',
        '#### 你好啊，陌生人!',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/post-606589-17#164');

    expect(result).toContain('NodeSeek 主题详情');
    expect(result).toContain('主题: Later page title');
    expect(result).toContain('链接: https://www.nodeseek.com/post-606589-17#164');
    expect(result).toContain('alice: 第一页之后的回复正文。');
    expect(result).toContain('bob: 最后一条回复。');
    expect(result).not.toContain('1..1314151617');
    expect(result).not.toContain('post-606589-16');
    expect(result).not.toContain('所有版块');
    expect(result).not.toContain('Image 2');
    expect(result).not.toContain('登录 或者 注册');
  });

  it('uses the V2EX public latest topics API for the homepage', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          title: 'V2EX topic one',
          url: 'https://www.v2ex.com/t/1',
          replies: 3,
          member: { username: 'alice' },
          node: { title: '程序员' },
          content: 'topic body',
        },
      ],
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/topics/latest.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('V2EX 最新主题');
    expect(result).toContain('V2EX topic one');
    expect(result).toContain('alice');
    expect(result).not.toContain('font-family');
  });

  it('uses the V2EX public latest topics API for recent pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          title: 'Recent V2EX topic',
          url: 'https://www.v2ex.com/t/2',
          replies: 5,
          member: { username: 'bob' },
          node: { title: '分享创造' },
          content: 'recent body',
        },
      ],
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/recent');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/topics/latest.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('V2EX 最新主题');
    expect(result).toContain('Recent V2EX topic');
    expect(result).toContain('bob');
    expect(result).not.toContain('Recent Topics 1/');
  });

  it('uses the V2EX public all-nodes API for node index pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 1,
          name: 'babel',
          title: 'Project Babel',
          url: 'https://www.v2ex.com/go/babel',
          topics: 1123,
          stars: 410,
          header: 'Across the Universe',
        },
        {
          id: 2,
          name: 'v2ex',
          title: 'V2EX',
          url: 'https://www.v2ex.com/go/v2ex',
          topics: 4126,
          stars: 1387,
          root: true,
        },
      ],
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/nodes');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/nodes/all.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('V2EX 节点列表');
    expect(result).toContain('Project Babel');
    expect(result).toContain('主题: 1123');
    expect(result).toContain('收藏: 410');
    expect(result).toContain('https://www.v2ex.com/go/babel');
    expect(result).not.toContain('发音 Pronunciation');
    expect(result).not.toContain('font-family');
  });

  it('uses the V2EX public changes page as a structured recent updates source', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        '<!DOCTYPE html><html><head><title>V2EX › 全站最近更新列表</title></head><body>',
        '<div id="Top"><a href="/">Home</a><a href="/signup">Sign Up</a><a href="/signin">Sign In</a></div>',
        '<div class="box">',
        '<div class="header"><a href="/">V2EX</a> <span class="chevron">&nbsp;›&nbsp;</span> 全站最近更新列表</div>',
        '<div class="cell item">',
        '<span class="item_title"><a href="/t/1214850#reply0" class="topic-link" id="topic-link-1214850">AeonRiddles 中文名定为“诡案迷踪”</a></span>',
        '<span class="topic_info"><div class="votes"></div><a class="node" href="/go/programmer">程序员</a> &nbsp;•&nbsp; <strong><a href="/member/Srande">Srande</a></strong> &nbsp;•&nbsp; <span title="2026-05-23 06:08:40 +08:00">8 mins ago</span></span>',
        '</div>',
        '<div class="cell item">',
        '<span class="item_title"><a href="/t/1214693#reply51" class="topic-link" id="topic-link-1214693">Surge 作者将 𝕏 个人简介修改为已退休</a></span>',
        '<span class="topic_info"><div class="votes"></div><a class="node" href="/go/apple">Apple</a> &nbsp;•&nbsp; <strong><a href="/member/adaashili">adaashili</a></strong> &nbsp;•&nbsp; <span title="2026-05-23 06:12:35 +08:00">4 mins ago</span> &nbsp;•&nbsp; Lastly replied by <strong><a href="/member/wazggcd">wazggcd</a></strong></span>',
        '<a href="/t/1214693#reply51" class="count_livid">51</a>',
        '</div>',
        '</div></body></html>',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/changes');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/changes',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html, */*' }) }),
    );
    expect(result).toContain('V2EX 全站最近更新');
    expect(result).toContain('AeonRiddles 中文名定为“诡案迷踪”');
    expect(result).toContain('节点: 程序员');
    expect(result).toContain('作者: Srande');
    expect(result).toContain('时间: 8 mins ago');
    expect(result).toContain('链接: https://www.v2ex.com/t/1214850#reply0');
    expect(result).toContain('最后回复: wazggcd');
    expect(result).toContain('回复: 51');
    expect(result).not.toContain('Home Sign Up Sign In');
    expect(result).not.toContain('状态: 已截断');
  });

  it('uses V2EX tag pages as structured topic lists', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        '<!DOCTYPE html><html><head><title>V2EX › Python</title></head><body>',
        '<div id="Top"><a href="/">Home</a><a href="/signup">Sign Up</a><a href="/signin">Sign In</a></div>',
        '<div class="box">',
        '<div class="header"><a href="/">V2EX</a> <span class="chevron">&nbsp;›&nbsp;</span> Python</div>',
        '<div class="cell item">',
        '<span class="item_title"><a href="/t/1214001#reply2" class="topic-link" id="topic-link-1214001">有没有涵盖 AI 协同编程的 Python 零基础课程？</a></span>',
        '<span class="topic_info"><div class="votes"></div><a class="node" href="/go/qna">问与答</a> &nbsp;•&nbsp; <strong><a href="/member/oix">oix</a></strong> &nbsp;•&nbsp; <span title="2026-05-18 10:00:00 +08:00">4 days ago</span> &nbsp;•&nbsp; Lastly replied by <strong><a href="/member/oix">oix</a></strong></span>',
        '<a href="/t/1214001#reply2" class="count_livid">2</a>',
        '</div>',
        '<div class="cell item">',
        '<span class="item_title"><a href="/t/1213002" class="topic-link" id="topic-link-1213002">VSCode 在 venv 环境下格式化 Python 代码的正确方式是什么</a></span>',
        '<span class="topic_info"><div class="votes"></div><a class="node" href="/go/vscode">Visual Studio Code</a> &nbsp;•&nbsp; <strong><a href="/member/bouts0309">bouts0309</a></strong> &nbsp;•&nbsp; <span title="2026-05-08 12:00:00 +08:00">14 days ago</span></span>',
        '<a href="/t/1213002#reply9" class="count_livid">9</a>',
        '</div>',
        '</div></body></html>',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/tag/python');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/tag/python',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html, */*' }) }),
    );
    expect(result).toContain('V2EX Python 标签主题');
    expect(result).toContain('有没有涵盖 AI 协同编程的 Python 零基础课程？');
    expect(result).toContain('节点: 问与答');
    expect(result).toContain('作者: oix');
    expect(result).toContain('最后回复: oix');
    expect(result).toContain('回复: 2');
    expect(result).toContain('链接: https://www.v2ex.com/t/1214001#reply2');
    expect(result).not.toContain('Home Sign Up Sign In');
    expect(result).not.toContain('状态: 已截断');
  });

  it('uses the V2EX public member and topics APIs for member pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 1,
          username: 'Livid',
          url: 'https://www.v2ex.com/u/Livid',
          website: 'sepia.sol.build',
          tagline: 'Remember the bigger green',
          created: 1272203146,
          status: 'found',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            title: 'The Virtual OS Museum',
            url: 'https://www.v2ex.com/t/1214268',
            replies: 0,
            member: { username: 'Livid' },
            node: { title: '怀旧游戏' },
            content: 'Virtual OS topic body',
          },
          {
            title: 'V2EX 新的测试服及 Passkey 支持',
            url: 'https://www.v2ex.com/t/1214267',
            replies: 41,
            member: { username: 'Livid' },
            node: { title: 'Wunder' },
            content: 'Passkey topic body',
          },
        ],
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/member/livid');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/members/show.json?username=livid',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/topics/show.json?username=livid',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('V2EX 会员资料');
    expect(result).toContain('用户: Livid');
    expect(result).toContain('签名: Remember the bigger green');
    expect(result).toContain('网站: sepia.sol.build');
    expect(result).toContain('The Virtual OS Museum');
    expect(result).toContain('节点: 怀旧游戏');
    expect(result).toContain('V2EX 新的测试服及 Passkey 支持');
    expect(result).not.toContain('Solana Give SOL');
    expect(result).not.toContain('font-family');
  });

  it('uses a Linux.do reader-backed Discourse JSON source when direct JSON is challenged', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 123,
                slug: 'hello-linux-do',
                title: 'Linux.do topic one',
                reply_count: 7,
                views: 88,
                last_poster_username: 'alice',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/latest');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 最新主题');
    expect(result).toContain('Linux.do topic one');
    expect(result).toContain('回复: 7');
    expect(result).toContain('最后回复: alice');
    expect(result).toContain('https://linux.do/t/hello-linux-do/123');
    expect(result).not.toContain('Just a moment');
  });

  it('uses the public Linux.do latest feed for new topics', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?order=created',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 321,
                slug: 'linux-new-topic',
                title: 'Linux.do new topic',
                reply_count: 1,
                views: 23,
                last_poster_username: 'newbie',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/new');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?order=created',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?order=created',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      'https://linux.do/new.json',
      expect.anything(),
    );
    expect(result).toContain('Linux.do 新主题');
    expect(result).toContain('Linux.do new topic');
    expect(result).toContain('最后回复: newbie');
  });

  it('preserves Linux.do JSON query strings', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?order=created',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 654,
                slug: 'queried-new-topic',
                title: 'Queried new topic',
                reply_count: 4,
                views: 56,
                last_poster_username: 'query-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/latest.json?order=created');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?order=created',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?order=created',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 新主题');
    expect(result).toContain('Queried new topic');
    expect(result).toContain('最后回复: query-user');
  });

  it('preserves Linux.do latest page query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?order=created',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 655,
                slug: 'latest-query-new-topic',
                title: 'Latest query new topic',
                reply_count: 2,
                views: 22,
                last_poster_username: 'latest-query-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/latest?order=created');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?order=created',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?order=created',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 新主题');
    expect(result).toContain('Latest query new topic');
    expect(result).toContain('最后回复: latest-query-user');
  });

  it('maps Linux.do numeric latest pages to the public latest JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 2227001,
                slug: 'latest-page-two-topic',
                title: 'Linux.do latest page two topic',
                reply_count: 8,
                views: 321,
                last_poster_username: 'page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/latest/2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 最新主题');
    expect(result).toContain('Linux.do latest page two topic');
    expect(result).toContain('最后回复: page-user');
    expect(result).toContain('https://linux.do/t/latest-page-two-topic/2227001');
    expect(result).not.toContain('Just a moment');
  });

  it('preserves Linux.do new page query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?order=created&page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 657,
                slug: 'new-page-two-topic',
                title: 'New page two topic',
                reply_count: 5,
                views: 25,
                last_poster_username: 'new-page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/new?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?order=created&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?order=created&page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 新主题');
    expect(result).toContain('New page two topic');
    expect(result).toContain('最后回复: new-page-user');
  });

  it('maps Linux.do top period pages to the public top JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?period=weekly',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 656,
                slug: 'weekly-top-topic',
                title: 'Weekly top topic',
                reply_count: 6,
                views: 66,
                last_poster_username: 'weekly-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/top/weekly');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?period=weekly',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?period=weekly',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 热门主题');
    expect(result).toContain('Weekly top topic');
    expect(result).toContain('最后回复: weekly-user');
  });

  it('preserves Linux.do top period page query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?period=weekly&page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 658,
                slug: 'weekly-page-two-topic',
                title: 'Weekly top page two topic',
                reply_count: 4,
                views: 64,
                last_poster_username: 'weekly-page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/top/weekly?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?period=weekly&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?period=weekly&page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 热门主题');
    expect(result).toContain('Weekly top page two topic');
    expect(result).toContain('最后回复: weekly-page-user');
  });

  it('uses a Linux.do reader-backed Discourse JSON source for topic pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/t/123.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            id: 123,
            slug: 'hello-linux-do',
            title: 'Linux.do topic detail',
            posts_count: 2,
            post_stream: {
              posts: [
                { username: 'alice', cooked: '<p>main body</p>' },
                { username: 'bob', cooked: '<p>reply body</p>' },
              ],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/t/hello-linux-do/123/2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/t/123.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/t/123.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 主题详情');
    expect(result).toContain('主题: Linux.do topic detail');
    expect(result).toContain('作者: alice');
    expect(result).toContain('正文: main body');
    expect(result).toContain('bob: reply body');
  });

  it('normalizes bare Linux.do topic id pages to the topic JSON route', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/t/topic/2228655.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            id: 2228655,
            slug: 'topic',
            title: 'Bare id Linux.do topic',
            post_stream: {
              posts: [
                { username: 'alice', cooked: '<p>bare id main body</p>' },
              ],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/t/2228655');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/t/topic/2228655.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/t/topic/2228655.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 主题详情');
    expect(result).toContain('Bare id Linux.do topic');
    expect(result).toContain('bare id main body');
  });

  it('uses a Linux.do reader-backed Discourse JSON source for category pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?category=4',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 456,
                slug: 'category-topic',
                title: 'Linux.do category topic',
                reply_count: 2,
                views: 34,
                last_poster_username: 'carol',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop/4');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?category=4',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?category=4',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do category topic');
    expect(result).toContain('最后回复: carol');
  });

  it('uses a Linux.do reader-backed Discourse JSON source for slug-only category pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/c/develop.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 461,
                slug: 'slug-category-topic',
                title: 'Linux.do slug-only category topic',
                reply_count: 3,
                views: 45,
                last_poster_username: 'slug-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/c/develop.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/c/develop.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do slug-only category topic');
    expect(result).toContain('最后回复: slug-user');
  });

  it('resolves Linux.do slug-only categories through the public categories index when direct category JSON is challenged', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Just a moment...',
          '',
          'URL Source: http://linux.do/c/develop.json',
          '',
          'Warning: This page maybe requiring CAPTCHA',
          '',
          'Markdown Content:',
          '# Just a moment...',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          category_list: {
            categories: [
              { id: 4, name: 'Develop', slug: 'develop' },
              { id: 2, name: 'Feedback', slug: 'feedback' },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          topic_list: {
            topics: [{
              id: 462,
              slug: 'resolved-category-topic',
              title: 'Linux.do resolved category topic',
              reply_count: 4,
              views: 56,
              last_poster_username: 'resolved-user',
            }],
          },
        }),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/c/develop.json?page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/categories.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?category=4&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do resolved category topic');
    expect(result).toContain('最后回复: resolved-user');
  });

  it('preserves Linux.do category page query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?category=4&page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 460,
                slug: 'category-page-two-topic',
                title: 'Linux.do category page two topic',
                reply_count: 2,
                views: 24,
                last_poster_username: 'page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop/4?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?category=4&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?category=4&page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do category page two topic');
    expect(result).toContain('最后回复: page-user');
  });

  it('uses a Linux.do public JSON source for the categories index', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        category_list: {
          categories: [
            {
              id: 4,
              name: '开发调优',
              slug: 'develop',
              topic_count: 12,
              post_count: 34,
              description_text: '开发、测试、调试相关讨论。',
            },
            {
              id: 2,
              name: '运营反馈',
              slug: 'feedback',
              topic_count: 5,
              post_count: 6,
              description_excerpt: '站点反馈。',
            },
          ],
        },
      }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/categories');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/categories.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 分类列表');
    expect(result).toContain('开发调优');
    expect(result).toContain('主题: 12');
    expect(result).toContain('https://linux.do/c/develop/4');
    expect(result).toContain('开发、测试、调试相关讨论。');
  });

  it('maps Linux.do category top pages to the public top JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?category=4',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 457,
                slug: 'category-top-topic',
                title: 'Linux.do category top topic',
                reply_count: 9,
                views: 99,
                last_poster_username: 'top-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop/4/l/top');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?category=4',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?category=4',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do category top topic');
    expect(result).toContain('最后回复: top-user');
  });

  it('maps Linux.do category top period pages to the public top JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?category=4&period=weekly',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 459,
                slug: 'category-weekly-topic',
                title: 'Linux.do category weekly topic',
                reply_count: 4,
                views: 44,
                last_poster_username: 'category-weekly-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop/4/l/top/weekly');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?category=4&period=weekly',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?category=4&period=weekly',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do category weekly topic');
    expect(result).toContain('最后回复: category-weekly-user');
  });

  it('preserves Linux.do category top query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?category=4&period=weekly&page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 461,
                slug: 'category-weekly-page-two-topic',
                title: 'Linux.do category weekly page two topic',
                reply_count: 3,
                views: 33,
                last_poster_username: 'weekly-page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop/4/l/top/weekly?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?category=4&period=weekly&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?category=4&period=weekly&page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do category weekly page two topic');
    expect(result).toContain('最后回复: weekly-page-user');
  });

  it('maps Linux.do category new pages to the public created-order feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/latest.json?category=4&order=created',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 458,
                slug: 'category-new-topic',
                title: 'Linux.do category new topic',
                reply_count: 1,
                views: 11,
                last_poster_username: 'new-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/c/develop/4/l/new');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/latest.json?category=4&order=created',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/latest.json?category=4&order=created',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do category new topic');
    expect(result).toContain('最后回复: new-user');
  });

  it('uses a Linux.do reader-backed Discourse JSON source for tag pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/tag/1461-tag/1461.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 789,
                slug: 'tag-topic',
                title: 'Linux.do tag topic',
                reply_count: 5,
                views: 67,
                last_poster_username: 'dave',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/1461-tag/1461');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/tag/1461-tag/1461.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/tag/1461-tag/1461.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do tag topic');
    expect(result).toContain('最后回复: dave');
  });

  it('uses a Linux.do public JSON source for the tags index', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        tags: [
          { id: 3, name: 'ChatGPT', slug: 'chatgpt', count: 14692, description: 'AI topic' },
          { id: 4, name: 'OpenAI', slug: 'openai', count: 7593 },
        ],
      }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tags');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/tags.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 标签列表');
    expect(result).toContain('ChatGPT');
    expect(result).toContain('主题: 14692');
    expect(result).toContain('https://linux.do/tag/chatgpt');
    expect(result).toContain('AI topic');
  });

  it('uses the Linux.do public search JSON source for search pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        topics: [
          {
            id: 801,
            slug: 'search-topic',
            title: 'Linux.do search topic',
            posts_count: 6,
            reply_count: 4,
            views: 123,
          },
        ],
        posts: [
          {
            topic_id: 801,
            username: 'search-user',
            blurb: '<p>matched <mark>codex</mark> content</p>',
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/search?q=codex&page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/search.json?q=codex&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 搜索结果');
    expect(result).toContain('Linux.do search topic');
    expect(result).toContain('作者: search-user');
    expect(result).toContain('摘要: matched codex content');
    expect(result).toContain('https://linux.do/t/search-topic/801');
  });

  it('returns Linux.do search rate-limit JSON without falling through to direct fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        failed: 'FAILED',
        message: 'You’ve performed this action too many times, please try again later.',
      }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/search?q=codex');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/search.json?q=codex',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 搜索受限');
    expect(result).toContain('You’ve performed this action too many times');
  });

  it('uses the Linux.do public user summary JSON source for user pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        users: [
          {
            username: 'system',
            name: 'system',
            admin: true,
            moderator: true,
            trust_level: 4,
          },
        ],
        user_summary: {
          likes_received: 10393,
          post_count: 998,
          topic_count: 6,
        },
        topics: [
          {
            id: 873738,
            slug: 'topic',
            title: '夸克网盘监控',
            posts_count: 523,
            like_count: 739,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/u/system');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/users/system/summary.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 用户概况');
    expect(result).toContain('用户: system');
    expect(result).toContain('权限: admin, moderator');
    expect(result).toContain('获赞: 10393');
    expect(result).toContain('夸克网盘监控');
    expect(result).toContain('https://linux.do/t/topic/873738');
  });

  it('uses the Linux.do public user activity RSS source for activity pages', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/rss+xml; charset=utf-8' }),
      text: async () => [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '<channel>',
        '<title>LINUX DO - system 的最新帖子</title>',
        '<item>',
        '<title>夸克网盘监控</title>',
        '<link>https://linux.do/t/topic/873738/528</link>',
        '<dc:creator><![CDATA[@system system]]></dc:creator>',
        '<description><![CDATA[ <p>已找到 <strong>pan.quark.cn</strong> 的新结果！</p> ]]></description>',
        '<pubDate>Fri, 22 May 2026 15:57:46 +0000</pubDate>',
        '</item>',
        '<item>',
        '<title>百度网盘监控</title>',
        '<link>https://linux.do/t/topic/870444/441</link>',
        '<dc:creator><![CDATA[@system system]]></dc:creator>',
        '<description><![CDATA[ <p>已找到 <mark>pan.baidu.com</mark> 的新结果！</p> ]]></description>',
        '</item>',
        '</channel>',
        '</rss>',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/u/system/activity');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/u/system/activity.rss',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/rss+xml, text/xml, */*' }) }),
    );
    expect(result).toContain('Linux.do 用户动态');
    expect(result).toContain('夸克网盘监控');
    expect(result).toContain('作者: @system system');
    expect(result).toContain('摘要: 已找到 pan.quark.cn 的新结果！');
    expect(result).toContain('https://linux.do/t/topic/873738/528');
    expect(result).toContain('百度网盘监控');
  });

  it('uses the Linux.do public RSS source for user activity filters', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/rss+xml; charset=utf-8' }),
      text: async () => [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '<channel>',
        '<title>LINUX DO - Latest topics by @system</title>',
        '<item>',
        '<title>LINUX DO 2025 年度回顾</title>',
        '<link>https://linux.do/t/topic/1384193</link>',
        '<dc:creator><![CDATA[@system system]]></dc:creator>',
        '<description><![CDATA[ <p>年度回顾正文</p> ]]></description>',
        '<pubDate>Wed, 31 Dec 2025 16:32:23 +0000</pubDate>',
        '</item>',
        '</channel>',
        '</rss>',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/u/system/activity/topics');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/u/system/activity/topics.rss',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/rss+xml, text/xml, */*' }) }),
    );
    expect(result).toContain('Linux.do 用户动态');
    expect(result).toContain('LINUX DO 2025 年度回顾');
    expect(result).toContain('摘要: 年度回顾正文');
  });

  it('falls Linux.do user reply activity pages back to the public activity RSS source', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/rss+xml; charset=utf-8' }),
      text: async () => [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '<channel>',
        '<title>LINUX DO - Latest posts by @system</title>',
        '<item>',
        '<title>夸克网盘监控</title>',
        '<link>https://linux.do/t/topic/873738/528</link>',
        '<dc:creator><![CDATA[@system system]]></dc:creator>',
        '<description><![CDATA[ <p>回复活动正文</p> ]]></description>',
        '<pubDate>Fri, 22 May 2026 15:57:46 +0000</pubDate>',
        '</item>',
        '</channel>',
        '</rss>',
      ].join('\n'),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/u/system/activity/replies');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/u/system/activity.rss',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/rss+xml, text/xml, */*' }) }),
    );
    expect(result).toContain('Linux.do 用户动态');
    expect(result).toContain('夸克网盘监控');
    expect(result).toContain('摘要: 回复活动正文');
  });

  it('uses the Linux.do reader-backed about JSON source for about pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/about.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            users: [
              { id: 1, username: 'neo', name: 'Neo' },
              { id: 2, username: 'mod', name: 'Moderator' },
            ],
            about: {
              title: 'LINUX DO',
              description: '新的理想型社区',
              site_creation_date: '2023-04-23T00:00:00.000Z',
              admin_ids: [1],
              moderator_ids: [2],
              stats: {
                topics_count: 518353,
                posts_count: 17690653,
                users_count: 106425,
                active_users_30_days: 81869,
              },
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/about');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/about.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/about.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 站点信息');
    expect(result).toContain('站点: LINUX DO');
    expect(result).toContain('简介: 新的理想型社区');
    expect(result).toContain('主题: 518353');
    expect(result).toContain('帖子: 17690653');
    expect(result).toContain('用户: 106425');
    expect(result).toContain('近30天活跃用户: 81869');
    expect(result).toContain('管理员: neo');
    expect(result).toContain('版主: mod');
  });

  it('uses the Linux.do reader-backed FAQ page for guidelines pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Guidelines - LINUX DO',
          '',
          'URL Source: http://linux.do/faq',
          '',
          'Markdown Content:',
          '**真诚**、**友善**、**团结**、**专业**，共建你我引以为荣之社区。[《社区准则》](https://linux.do/guidelines)',
          '',
          '## [](http://linux.do/faq#p-4-h-1)基本信息',
          '*   **社区名称：**`LINUX DO`',
          '*   **社区简称：**`L站`',
          '*   **社区域名：**`linux.do`',
          '*   **社区愿景：**`新的理想型社区`',
          '',
          '## [](http://linux.do/faq#p-4-h-2)总体原则',
          '*   不可以傲慢。这是本论坛的氛围基调。',
          '*   不可以搞破坏。',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/faq');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/faq',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html, text/plain, */*' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/faq',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 社区准则');
    expect(result).toContain('真诚、友善、团结、专业');
    expect(result).toContain('社区名称: LINUX DO');
    expect(result).toContain('社区愿景: 新的理想型社区');
    expect(result).toContain('不可以傲慢');
    expect(result).not.toContain('Just a moment');
  });

  it('uses the Linux.do reader-backed guidelines page for the canonical guidelines URL', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Guidelines - LINUX DO',
          '',
          'URL Source: http://linux.do/guidelines',
          '',
          'Markdown Content:',
          '**真诚**、**友善**、**团结**、**专业**，共建你我引以为荣之社区。[《社区准则》](https://linux.do/guidelines)',
          '',
          '> **版本：**`2604241040`。施工中，随时变动。',
          '',
          '## [](http://linux.do/guidelines#p-4-h-1)基本信息',
          '*   **社区名称：**`LINUX DO`',
          '*   **成员称谓：**`佬友`',
          '*   **成立时间：**`2024-01-17`',
          '*   **社区域名：**`linux.do`',
          '*   **备用域名：**`linuxdo.org`',
          '*   **社区愿景：**`新的理想型社区`',
          '',
          '## [](http://linux.do/guidelines#p-4-h-2)总体原则',
          '*   不可以傲慢。这是本论坛的氛围基调。',
          '*   不可以搞破坏。',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/guidelines');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/guidelines',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html, text/plain, */*' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/guidelines',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 社区准则');
    expect(result).toContain('成员称谓: 佬友');
    expect(result).toContain('成立时间: 2024-01-17');
    expect(result).toContain('备用域名: linuxdo.org');
    expect(result).toContain('不可以傲慢');
    expect(result).not.toContain('Just a moment');
  });

  it('uses the Linux.do reader-backed terms page for terms of service', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Terms of Service - LINUX DO',
          '',
          'URL Source: http://linux.do/tos',
          '',
          'Markdown Content:',
          '# Terms of Service - LINUX DO',
          '',
          '## [重要条款](http://linux.do/tos#heading--important-terms)',
          '这些条款包含影响您权利的重要规定。',
          '',
          '## [您使用本论坛的权限](http://linux.do/tos#heading--permission)',
          '受这些条款约束，论坛授予您使用论坛的权限。',
          '',
          '## [可接受的使用](http://linux.do/tos#heading--acceptable-use)',
          '您不得违反法律或危害论坛。',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tos');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/tos',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html, text/plain, */*' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/tos',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 服务条款');
    expect(result).toContain('重要条款');
    expect(result).toContain('这些条款包含影响您权利的重要规定');
    expect(result).toContain('可接受的使用');
    expect(result).not.toContain('Just a moment');
  });

  it('uses the Linux.do reader-backed privacy page for the privacy policy', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: Privacy - LINUX DO',
          '',
          'URL Source: http://linux.do/privacy',
          '',
          'Markdown Content:',
          '**真诚**、**友善**、**团结**、**专业**，共建你我引以为荣之社区。[《社区准则》](https://linux.do/guidelines)',
          '',
          '## [](http://linux.do/privacy#p-544-collect-1)[我们收集哪些信息？](http://linux.do/privacy#collect)',
          '当您在我们的网站上注册时，我们会收集您的信息。',
          '',
          '## [](http://linux.do/privacy#p-544-use-2)[我们使用您的信息做什么？](http://linux.do/privacy#use)',
          '*   个性化设置您的体验。',
          '*   改进我们的网站。',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/privacy');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/privacy',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/html, text/plain, */*' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/privacy',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 隐私政策');
    expect(result).toContain('我们收集哪些信息？');
    expect(result).toContain('当您在我们的网站上注册时，我们会收集您的信息');
    expect(result).toContain('我们使用您的信息做什么？');
    expect(result).not.toContain('Just a moment');
  });

  it('uses the Linux.do reader-backed groups JSON source for group pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/groups.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            groups: [
              {
                id: 1,
                name: 'trust_level_3',
                full_name: 'Regular',
                user_count: 123,
                visibility_level: 0,
                public_admission: true,
              },
              {
                id: 2,
                name: 'staff',
                user_count: 4,
                visibility_level: 1,
              },
            ],
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/groups');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/groups.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/groups.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 群组列表');
    expect(result).toContain('Regular');
    expect(result).toContain('成员: 123');
    expect(result).toContain('staff');
  });

  it('uses the Linux.do reader-backed badges JSON source for badge pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/badges.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            badge_types: [
              { id: 1, name: 'Gold' },
              { id: 2, name: 'Silver' },
              { id: 3, name: 'Bronze' },
            ],
            badge_groupings: [
              { id: 5, name: 'Other' },
              { id: 2, name: 'Community' },
            ],
            badges: [
              {
                id: 120,
                name: '元气满满',
                description: '在人生重要时刻身着元气战袍，留下美好回忆。',
                grant_count: 2,
                badge_grouping_id: 5,
                badge_type_id: 1,
              },
              {
                id: 112,
                name: 'Solution Institution',
                description: 'Have 150 replies marked as Solutions',
                grant_count: 25,
                badge_grouping_id: 2,
                badge_type_id: 1,
              },
            ],
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/badges');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/badges.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/badges.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 徽章列表');
    expect(result).toContain('元气满满');
    expect(result).toContain('类型: Gold');
    expect(result).toContain('分组: Other');
    expect(result).toContain('授予次数: 2');
    expect(result).toContain('Solution Institution');
    expect(result).toContain('Have 150 replies marked as Solutions');
  });

  it('uses the Linux.do reader-backed badge detail JSON source for individual badge pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/badges/1.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            badge_types: [
              { id: 3, name: 'Bronze' },
            ],
            badge: {
              id: 1,
              name: 'Basic',
              description: '<a href="https://blog.discourse.org/">Granted</a> all essential community functions',
              grant_count: 109147,
              allow_title: false,
              multiple_grant: false,
              icon: 'user',
              listable: true,
              enabled: true,
              badge_grouping_id: 4,
              system: true,
              long_description: 'This badge is granted when you reach trust level 1. New user restrictions have been lifted.',
              slug: '-',
              badge_type_id: 3,
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/badges/1/basic');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/badges/1.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/badges/1.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 徽章详情');
    expect(result).toContain('徽章: Basic');
    expect(result).toContain('类型: Bronze');
    expect(result).toContain('授予次数: 109147');
    expect(result).toContain('图标: user');
    expect(result).toContain('摘要: Granted all essential community functions');
    expect(result).toContain('说明: This badge is granted when you reach trust level 1. New user restrictions have been lifted.');
    expect(result).not.toContain('Just a moment');
  });

  it('maps Linux.do bare tag pages to the public tag JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/tag/codex.json',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 790,
                slug: 'bare-tag-topic',
                title: 'Linux.do bare tag topic',
                reply_count: 3,
                views: 44,
                last_poster_username: 'tag-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/codex');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/tag/codex.json',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/tag/codex.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do bare tag topic');
    expect(result).toContain('最后回复: tag-user');
  });

  it('preserves Linux.do tag page query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/tag/codex.json?page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 793,
                slug: 'tag-page-two-topic',
                title: 'Linux.do tag page two topic',
                reply_count: 1,
                views: 12,
                last_poster_username: 'tag-page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/codex?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/tag/codex.json?page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/tag/codex.json?page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do tag page two topic');
    expect(result).toContain('最后回复: tag-page-user');
  });

  it('maps Linux.do tag top pages to the public top JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?tags=codex',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 791,
                slug: 'tag-top-topic',
                title: 'Linux.do tag top topic',
                reply_count: 8,
                views: 88,
                last_poster_username: 'tag-top-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/codex/l/top');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?tags=codex',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?tags=codex',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do tag top topic');
    expect(result).toContain('最后回复: tag-top-user');
  });

  it('maps Linux.do tag top period pages to the public top JSON feed', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?tags=codex&period=weekly',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 792,
                slug: 'tag-weekly-topic',
                title: 'Linux.do tag weekly topic',
                reply_count: 7,
                views: 77,
                last_poster_username: 'tag-weekly-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/codex/l/top/weekly');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?tags=codex&period=weekly',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?tags=codex&period=weekly',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do tag weekly topic');
    expect(result).toContain('最后回复: tag-weekly-user');
  });

  it('preserves Linux.do tag top query strings when mapping to JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: ',
          '',
          'URL Source: http://linux.do/top.json?tags=codex&period=weekly&page=2',
          '',
          'Markdown Content:',
          JSON.stringify({
            topic_list: {
              topics: [{
                id: 794,
                slug: 'tag-weekly-page-two-topic',
                title: 'Linux.do tag weekly page two topic',
                reply_count: 6,
                views: 76,
                last_poster_username: 'tag-weekly-page-user',
              }],
            },
          }),
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/codex/l/top/weekly?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?tags=codex&period=weekly&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://r.jina.ai/http://linux.do/top.json?tags=codex&period=weekly&page=2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('Linux.do tag weekly page two topic');
    expect(result).toContain('最后回复: tag-weekly-page-user');
  });

  it('returns an empty Linux.do topic list without falling through to direct fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        topic_list: {
          topics: [],
        },
      }),
    }) as unknown as typeof fetch;

    const result = await executeFetch('https://linux.do/tag/codex/l/top/weekly?page=2');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://linux.do/top.json?tags=codex&period=weekly&page=2',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Linux.do 分类/标签主题');
    expect(result).toContain('暂无主题');
  });

  it('does not return a worker-provided Cloudflare challenge page for nodeseek.com', async () => {
    mockEnv.mockReturnValue({
      FETCH_GATEWAY_URL: undefined,
      FETCH_WORKER_URL: 'https://worker.example/fetch',
      NODESEEK_READER_URLS: undefined,
      WEB_FETCH_USER_AGENT: 'XXB-WebFetch/1.0',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: 'Title: Just a moment...\n\nMarkdown Content:\nPerforming security verification',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/',
          '',
          'Markdown Content:',
          '# NodeSeek',
          'worker fallback content',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(result).toContain('worker fallback content');
    expect(result).not.toContain('Performing security verification');
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('nodeseek.cc'),
      expect.anything(),
    );
  });

  it('does not return a direct 200 Cloudflare challenge page for nodeseek.com', async () => {
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 200,
      headers: {
        server: 'cloudflare',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body>Performing security verification</body></html>',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/',
          '',
          'Markdown Content:',
          '# NodeSeek direct fallback content',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(result).toContain('NodeSeek direct fallback content');
    expect(result).not.toContain('Just a moment');
    expect(result).not.toContain('Performing security verification');
  });

  it('uses configured nodeseek.com reader templates before the default reader', async () => {
    mockEnv.mockReturnValue({
      FETCH_GATEWAY_URL: undefined,
      FETCH_WORKER_URL: undefined,
      NODESEEK_READER_URLS: 'https://reader.example/{URL_ENCODED},https://r.jina.ai/http://{URL}',
      WEB_FETCH_USER_AGENT: 'XXB-WebFetch/1.0',
    });
    mockFetchUrlPinned.mockResolvedValue({
      statusCode: 403,
      headers: {
        server: 'cloudflare',
        'cf-mitigated': 'challenge',
        'content-type': 'text/html; charset=UTF-8',
      },
      body: '<html><head><title>Just a moment...</title></head><body>challenge</body></html>',
    });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'all methods failed' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => [
          'Title: NodeSeek',
          '',
          'URL Source: http://www.nodeseek.com/',
          '',
          'Markdown Content:',
          '# configured reader content',
        ].join('\n'),
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.nodeseek.com/');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://reader.example/http%3A%2F%2Fwww.nodeseek.com%2F',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain('configured reader content');
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('nodeseek.cc'),
      expect.anything(),
    );
  });

  it('uses the V2EX public topic and replies APIs for topic pages', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          title: 'Topic title',
          url: 'https://www.v2ex.com/t/123',
          replies: 2,
          member: { username: 'alice' },
          node: { title: '程序员' },
          content: 'topic body',
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          member: { username: 'bob' },
          content: 'reply body',
        }],
      }) as unknown as typeof fetch;

    const result = await executeFetch('https://www.v2ex.com/t/123#reply1');

    expect(mockFetchUrlPinned).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/topics/show.json?id=123',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.v2ex.com/api/replies/show.json?topic_id=123',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    expect(result).toContain('Topic title');
    expect(result).toContain('bob');
    expect(result).toContain('reply body');
  });
});
