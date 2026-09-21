/**
 * StepFun 全网搜索（2026-09-20 起的主路由）。
 *
 * 锁三件容易回归的事：
 *   1. 它是主路由 —— stepfun 开着一路走到它，不再先问 Gemini
 *   2. 服务端不认 max_results（恒返回 10 条）→ 必须在客户端切
 *   3. 失败要 fallback，不能把整条搜索链带崩
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state: { body: unknown; url: string; init: RequestInit | undefined } = { body: null, url: '', init: undefined };

const envMock: Record<string, unknown> = {
  STEPFUN_SEARCH_ENABLED: true,
  STEPFUN_SEARCH_API_KEY: 'test-key',
  STEPFUN_SEARCH_BASE_URL: 'https://api.stepfun.com/step_plan/v1',
  STEPFUN_SEARCH_MAX_RESULTS: 3,
  STEPFUN_SEARCH_CATEGORY: '',
};
vi.mock('../../../../src/env.js', () => ({ env: () => envMock }));

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  state.url = url;
  state.init = init;
  state.body = init?.body ? JSON.parse(String(init.body)) : null;
  // round 132：主路由从 REST `/v1/search` 换成 MCP `/mcp/web_search/mcp`。
  // MCP 的 text 里裹一层 JSON，所以要给那个形状。
  const rows = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/${i}`,
    position: i + 1,
    title: `标题${i}`,
    time: '2026-09-20 00:00:00',
    snippet: `摘要${i}`,
    content: `全文${i}`,
  }));
  return {
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ query: 'q', category: '', results: rows }) }],
      },
    }),
  } as unknown as Response;
});
const m = await import('../../../../src/pipeline/tools/search.js');

// **stub 必须每个用例重打**：afterEach 若 unstubAllGlobals，第 2 个用例起就没有
// fetch stub，会走真网络再落到 DDG fallback——输出当然不含 [N]，而实现是对的。
beforeEach(() => {
  envMock.STEPFUN_SEARCH_ENABLED = true;
  envMock.STEPFUN_SEARCH_CATEGORY = '';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

describe('StepFun 搜索（主路由）', () => {
  it('打到 /v1/search 且带 Bearer key', async () => {
    await m.executeSearch('测试');
    expect(state.url).toBe('https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp');
    const h = (state.init?.headers as Record<string, string>) ?? {};
    expect(h.Authorization).toBe('Bearer test-key');
    expect(state.body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call' });
    expect(state.body.params).toMatchObject({ name: 'web_search', arguments: { query: '测试' } });
  });

  it('max_results 不被服务端尊重 → 客户端切到 3 条', async () => {
    const out = await m.executeSearch('测试');
    const n = (out.match(/^- 标题/gm) ?? []).length;
    expect(n).toBe(3);
    expect(out).toContain('标题0');
    expect(out).not.toContain('标题9');
  });

  it('带 category 时透传', async () => {
    envMock.STEPFUN_SEARCH_CATEGORY = 'programming';
    await m.executeSearch('TS');
    expect(state.body.params).toMatchObject({ arguments: { category: 'programming' } });
    envMock.STEPFUN_SEARCH_CATEGORY = '';
  });

  it('STEPFUN_SEARCH_ENABLED === false 时不打 stepfun（落后备）', async () => {
    envMock.STEPFUN_SEARCH_ENABLED = false;
    await m.executeSearch('测试').catch(() => {});
    // 不能断言 fetch 没被调：关掉 stepfun 会落到 DDG，DDG 也走 fetch。
    // 该断言的是"没有请求打到 stepfun 的 /v1/search"。
    expect(state.url).not.toContain('api.stepfun.com');
  });

  it('stepfun 挂了要 fallback，不抛给调用方', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    // 没有 GEMINI/XAI/SEARXNG key，会落到 DDG；这里只要求"不抛"
    await expect(m.executeSearch('测试')).resolves.toBeTypeOf('string');
  });
});
