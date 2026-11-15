import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ STEPFUN_SEARCH_ENABLED: false, STEPFUN_SEARCH_API_KEY: '',
  STEPFUN_SEARCH_BASE_URL: 'https://api.stepfun.com', STEPFUN_SEARCH_MAX_RESULTS: 3, STEPFUN_SEARCH_CATEGORY: '',
  SEARXNG_URL: '', XAI_API_KEY: '', XAI_SEARCH_BASE_URL: 'https://configured.example/v1', XAI_SEARCH_MODEL: 'search' }));
vi.mock('../../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { executeSearch, executeSearchDetailed, parseDdgLiteHtml } from '../../../../src/pipeline/tools/search.js';

// Actual result-link markup observed through deployment Node22 fetch on 2026-11-14.
// The description is shortened; URL escaping and the live attribute order are kept.
const liveDdgResult = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&amp;rut=4745c550d23793ae45495b2d67b2e511e339bf9c21cc41d57ec476864506aa2c" class='result-link'>The starting point for learning TypeScript</a>
<td class='result-snippet'>Learn <b>TypeScript</b> from the <b>official</b> site.</td>`;
const fetchMock = vi.fn();
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  Object.assign(config, { STEPFUN_SEARCH_ENABLED: false, STEPFUN_SEARCH_API_KEY: '', SEARXNG_URL: '', XAI_API_KEY: '' });
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('real DDG HTML parsing', () => {
  it('unwraps the deployment-observed redirect and strips snippet markup', () => {
    expect(parseDdgLiteHtml(liveDdgResult)).toEqual([{ title: 'The starting point for learning TypeScript',
      url: 'https://www.typescriptlang.org/docs/', snippet: 'Learn TypeScript from the official site.' }]);
  });
  it('accepts changed attribute order, double/single quotes and entities without accepting executable URLs', () => {
    const data = `<a class="result-link" data-other="ok" href='https://example.org/?a=1&amp;b=2'>A &amp; B &#x4E2D;</a>
      <td class="result-snippet">One&nbsp;two &#39;three&#39;</td>
      <a href="javascript:alert(1)" class="result-link">unsafe</a><td class="result-snippet">bad</td>`;
    expect(parseDdgLiteHtml(data)).toEqual([{ title: 'A & B 中', url: 'https://example.org/?a=1&b=2', snippet: "One two 'three'" }]);
  });
});

describe('search availability and fallback', () => {
  it('uses the working GET form and returns structured source results', async () => {
    fetchMock.mockResolvedValue(html(liveDdgResult));
    const result = await executeSearchDetailed('TypeScript official documentation');
    expect(result).toMatchObject({ status: 'ok', provider: 'DDG-Lite', results: [{ url: 'https://www.typescriptlang.org/docs/' }] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('q=TypeScript+official+documentation');
    expect(init.body).toBeUndefined(); expect(init.method ?? 'GET').toBe('GET');
  });
  it('classifies HTTP 202 anomaly responses as unavailable, including when no paid route is configured', async () => {
    fetchMock.mockImplementation(async () => html('<form id="challenge-form" action="/anomaly.js"><div class="anomaly-modal">challenge</div></form>', 202));
    expect(await executeSearchDetailed('测试')).toMatchObject({ status: 'unavailable', provider: null,
      attempts: expect.arrayContaining([{ provider: 'DDG-Lite', status: 'failed', code: 'blocked', httpStatus: 202 }]) });
    const message = await executeSearch('测试');
    expect(message).toContain('搜索不可用'); expect(message).not.toContain('没有找到');
  });
  it.each(['', '<html>Changed markup / maintenance page</html>'])('does not call an unrecognized page a valid zero-result response', async (body) => {
    fetchMock.mockResolvedValue(html(body));
    expect(await executeSearchDetailed('q')).toMatchObject({ status: 'unavailable', attempts: expect.arrayContaining([
      { provider: 'DDG-Lite', status: 'failed', code: 'invalid_response' },
    ]) });
  });
  it('accepts an explicit zero-result page, and does not mistake a captcha-related result snippet for a challenge', async () => {
    fetchMock.mockResolvedValueOnce(html('<div class="no-results">No results found for q</div>'));
    expect(await executeSearchDetailed('q')).toMatchObject({ status: 'empty', provider: 'DDG-Lite', results: [] });
    fetchMock.mockResolvedValueOnce(html(liveDdgResult.replace('official', 'captcha')));
    expect((await executeSearchDetailed('captcha docs')).status).toBe('ok');
  });
  it('continues past a configured SearxNG HTTP failure to a healthy DDG result', async () => {
    config.SEARXNG_URL = 'https://configured.example';
    fetchMock.mockResolvedValueOnce(json({ error: 'secret server details' }, 503)).mockResolvedValueOnce(html(liveDdgResult));
    const result = await executeSearchDetailed('q');
    expect(result.status).toBe('ok'); expect(result.provider).toBe('DDG-Lite');
    expect(result.attempts).toContainEqual({ provider: 'SearxNG', status: 'failed', code: 'http_error', httpStatus: 503 });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('distinguishes SearxNG engine failures from a confirmed empty result', async () => {
    config.SEARXNG_URL = 'https://configured.example';
    fetchMock.mockResolvedValueOnce(json({ results: [], unresponsive_engines: [['engine', 'timeout']] })).mockResolvedValueOnce(html('challenge', 202));
    expect(await executeSearchDetailed('q')).toMatchObject({ status: 'unavailable', attempts: expect.arrayContaining([
      { provider: 'SearxNG', status: 'failed', code: 'upstream_unavailable' },
    ]) });
    fetchMock.mockResolvedValueOnce(json({ results: [], unresponsive_engines: [] })).mockResolvedValueOnce(html('challenge', 202));
    expect(await executeSearchDetailed('q')).toMatchObject({ status: 'empty', provider: 'SearxNG' });
  });
  it.each([
    [new DOMException('private details', 'TimeoutError'), 'timeout'],
    [new TypeError('credential-bearing endpoint failed'), 'network'],
  ])('reports bounded error categories without returning exception strings', async (error, code) => {
    fetchMock.mockRejectedValue(error);
    const result = await executeSearchDetailed('q');
    expect(result.attempts).toContainEqual({ provider: 'DDG-Lite', status: 'failed', code });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
  it('classifies rate limits and does not accept unsourced model text as search evidence', async () => {
    config.XAI_API_KEY = 'secret-key';
    fetchMock.mockResolvedValueOnce(json({ choices: [{ message: { content: 'An unsupported answer.' } }] })).mockResolvedValueOnce(html('Too many requests', 429));
    const result = await executeSearchDetailed('q');
    expect(result.status).toBe('unavailable');
    expect(result.attempts).toContainEqual({ provider: 'new-api', status: 'failed', code: 'invalid_response' });
    expect(result.attempts).toContainEqual({ provider: 'DDG-Lite', status: 'failed', code: 'rate_limited', httpStatus: 429 });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('handles a successful MCP event-stream response with real source URLs', async () => {
    Object.assign(config, { STEPFUN_SEARCH_ENABLED: true, STEPFUN_SEARCH_API_KEY: 'test-key' });
    const payload = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Docs', url: 'https://example.org/docs', snippet: 'Snippet' }] }) }] } };
    fetchMock.mockResolvedValue(new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
    expect(await executeSearchDetailed('q')).toMatchObject({ status: 'ok', provider: 'StepFun-MCP', results: [{ title: 'Docs' }] });
  });
});
