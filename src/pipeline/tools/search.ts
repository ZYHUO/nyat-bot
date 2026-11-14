// A failed provider and a verified zero-result response are different outcomes.
// Existing tools use executeSearch; autonomous callers can inspect the typed result.
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const MAX_RESULTS = 5;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export type SearchProvider = 'StepFun-MCP' | 'StepFun-REST' | 'new-api' | 'SearxNG' | 'DDG-Lite';
export type SearchFailureCode = 'not_configured' | 'disabled' | 'timeout' | 'network' | 'blocked' | 'rate_limited' | 'unauthorized' | 'http_error' | 'invalid_response' | 'upstream_unavailable';
export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchAttempt {
  provider: SearchProvider;
  status: 'success' | 'empty' | 'failed' | 'skipped';
  code?: SearchFailureCode;
  httpStatus?: number;
}
export interface WebSearchOutcome {
  status: 'ok' | 'empty' | 'unavailable';
  provider: SearchProvider | null;
  results: SearchResult[];
  answer?: string;
  attempts: SearchAttempt[];
}
interface ProviderResult { results: SearchResult[]; answer?: string }

class SearchError extends Error {
  constructor(readonly code: SearchFailureCode, readonly httpStatus?: number) { super(code); }
}
function classifyFailure(error: unknown): { code: SearchFailureCode; httpStatus?: number } {
  if (error instanceof SearchError) return { code: error.code, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) };
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { code: 'timeout' };
  if (error instanceof SyntaxError) return { code: 'invalid_response' };
  return { code: 'invalid_response' };
}
async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    const timeout = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    throw new SearchError(timeout ? 'timeout' : 'network');
  }
  if (!response.ok) {
    const code = response.status === 429 ? 'rate_limited' : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'blocked' : 'http_error';
    throw new SearchError(code, response.status);
  }
  return response;
}

export async function executeSearchDetailed(query: string): Promise<WebSearchOutcome> {
  const e = env();
  const attempts: SearchAttempt[] = [];
  let emptyProvider: SearchProvider | null = null;
  const routes: Array<{ provider: SearchProvider; available: boolean; disabled?: boolean; run: () => Promise<ProviderResult> }> = [
    { provider: 'StepFun-MCP', available: e.STEPFUN_SEARCH_ENABLED !== false && !!e.STEPFUN_SEARCH_API_KEY,
      disabled: e.STEPFUN_SEARCH_ENABLED === false,
      run: () => stepfunMcpSearch(query, e.STEPFUN_SEARCH_API_KEY, e.STEPFUN_SEARCH_BASE_URL, e.STEPFUN_SEARCH_MAX_RESULTS, e.STEPFUN_SEARCH_CATEGORY) },
    { provider: 'StepFun-REST', available: e.STEPFUN_SEARCH_ENABLED !== false && !!e.STEPFUN_SEARCH_API_KEY,
      disabled: e.STEPFUN_SEARCH_ENABLED === false,
      run: () => stepfunSearch(query, e.STEPFUN_SEARCH_API_KEY, e.STEPFUN_SEARCH_BASE_URL, e.STEPFUN_SEARCH_MAX_RESULTS, e.STEPFUN_SEARCH_CATEGORY) },
    { provider: 'new-api', available: !!e.XAI_API_KEY,
      run: () => xaiSearch(query, e.XAI_API_KEY!, e.XAI_SEARCH_BASE_URL, e.XAI_SEARCH_MODEL) },
    { provider: 'SearxNG', available: !!e.SEARXNG_URL, run: () => searxngSearch(query, e.SEARXNG_URL!) },
    { provider: 'DDG-Lite', available: true, run: () => ddgLiteSearch(query) },
  ];
  for (const route of routes) {
    if (!route.available) {
      attempts.push({ provider: route.provider, status: 'skipped', code: route.disabled ? 'disabled' : 'not_configured' });
      continue;
    }
    try {
      const result = await route.run();
      attempts.push({ provider: route.provider, status: result.results.length ? 'success' : 'empty' });
      if (result.results.length) return { status: 'ok', provider: route.provider, ...result, attempts };
      emptyProvider ??= route.provider;
    } catch (error) {
      const failure = classifyFailure(error);
      attempts.push({ provider: route.provider, status: 'failed', ...failure });
      // Do not log provider bodies, credential-bearing URLs, queries, or raw errors.
      logger.warn({ provider: route.provider, ...failure }, 'Web search route failed');
    }
  }
  return { status: emptyProvider ? 'empty' : 'unavailable', provider: emptyProvider, results: [], attempts };
}

export async function executeSearch(query: string): Promise<string> {
  return formatSearchOutcome(query, await executeSearchDetailed(query));
}

/** Text compatibility for tools; callers must use status/results to decide whether evidence exists. */
export function formatSearchOutcome(query: string, outcome: WebSearchOutcome): string {
  if (outcome.status === 'unavailable') {
    const failed = outcome.attempts.filter((attempt) => attempt.status === 'failed').map((attempt) => `${attempt.provider}:${attempt.code}`).join(' / ');
    return `搜索不可用：${failed || '未配置可用的搜索来源'}。未完成有效查询，不能据此判断没有相关信息。`;
  }
  if (outcome.status === 'empty') return `搜索完成（${outcome.provider}）：未返回与“${query}”匹配的结果。`
    + (outcome.attempts.some((attempt) => attempt.status === 'failed') ? '其他搜索来源未能完成查询。' : '');
  let text = outcome.answer ? `${outcome.answer}\n\n来源：\n` : `关于“${query}”的搜索结果（${outcome.provider}）：\n`;
  for (const result of outcome.results) text += `- ${result.title}\n  ${result.snippet}\n  ${result.url}\n`;
  return text;
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? original;
    const hex = entity[1]?.toLowerCase() === 'x';
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : original;
  });
}
function plainText(value: string): string { return decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(); }
function sourceUrl(raw: string): string | null {
  try {
    const value = decodeEntities(raw);
    const parsed = new URL(value, 'https://duckduckgo.com');
    const target = parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/l/' ? parsed.searchParams.get('uddg') : value;
    if (!target) return null;
    const url = new URL(target.startsWith('//') ? `https:${target}` : target);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function rowsFromJson(value: unknown, limit: number): SearchResult[] {
  if (!Array.isArray(value)) throw new SearchError('invalid_response');
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const url = typeof row.url === 'string' ? sourceUrl(row.url) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = row.snippet ?? row.content ?? '';
    results.push({ url, title: typeof row.title === 'string' ? plainText(row.title).slice(0, 300) : '无标题',
      snippet: typeof snippet === 'string' ? plainText(snippet).slice(0, 500) : '' });
    if (results.length >= limit) break;
  }
  if (value.length && !results.length) throw new SearchError('invalid_response');
  return results;
}

async function stepfunMcpSearch(query: string, key: string, base: string, limit: number, category: string): Promise<ProviderResult> {
  const args: Record<string, unknown> = { query, n: Math.min(Math.max(limit, 1), 20) };
  if (category) args.category = category;
  const response = await request(`${base.replace(/\/+$/, '')}/mcp/web_search/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: args } }),
  }, 25_000);
  let data: unknown;
  if (response.headers?.get('content-type')?.includes('text/event-stream')) {
    for (const event of (await response.text()).split(/\r?\n\r?\n/)) {
      const text = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!text || text === '[DONE]') continue;
      const parsed = JSON.parse(text) as { id?: unknown };
      if (parsed.id === 1) data = parsed;
    }
  } else data = await response.json();
  if (!data || typeof data !== 'object') throw new SearchError('invalid_response');
  const rpc = data as { error?: unknown; result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean } };
  if (rpc.error || rpc.result?.isError) throw new SearchError('upstream_unavailable');
  const text = (rpc.result?.content ?? []).filter((item) => item.type === 'text' || item.type === undefined).map((item) => item.text ?? '').join('\n').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new SearchError('invalid_response');
  const parsed = JSON.parse(text.slice(start)) as { results?: unknown };
  return { results: rowsFromJson(parsed.results, limit) };
}
async function stepfunSearch(query: string, key: string, base: string, limit: number, category: string): Promise<ProviderResult> {
  const response = await request(`${base.replace(/\/+$/, '')}/v1/search`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, ...(category ? { category } : {}) }),
  }, 20_000);
  const data = await response.json() as { results?: unknown };
  return { results: rowsFromJson(data.results, limit) };
}
async function xaiSearch(query: string, key: string, base: string, model: string): Promise<ProviderResult> {
  const response = await request(`${base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: query }], search_parameters: { mode: 'on', return_citations: true }, stream: false, max_tokens: 800 }),
  }, 45_000);
  const data = await response.json() as { error?: unknown; choices?: Array<{ message?: { content?: string } }>;
    annotations?: Array<{ url_citation?: { url?: string; title?: string } }>; search_sources?: Array<{ url?: string; title?: string }> };
  if (data.error) throw new SearchError('upstream_unavailable');
  const answer = data.choices?.[0]?.message?.content?.trim();
  const results = rowsFromJson([...(data.search_sources ?? []), ...(data.annotations ?? []).map((item) => item.url_citation).filter(Boolean)], MAX_RESULTS);
  // A model answer without source URLs is not a verified web search.
  if (!answer || !results.length) throw new SearchError('invalid_response');
  return { results, answer: answer.slice(0, 6000) };
}

function attribute(attributes: string, name: string): string | null {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? null;
}
/** Accept both quoting styles/attribute orders; unwrap DDG redirects to source URLs. */
export function parseDdgLiteHtml(html: string): SearchResult[] {
  const snippets = [...html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
    .filter((match) => (attribute(match[1] ?? '', 'class') ?? '').split(/\s+/).includes('result-snippet'))
    .map((match) => plainText(match[2] ?? '').slice(0, 500));
  const results: SearchResult[] = [];
  let index = 0;
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!(attribute(match[1] ?? '', 'class') ?? '').split(/\s+/).includes('result-link')) continue;
    const snippet = snippets[index++] ?? '';
    const href = attribute(match[1] ?? '', 'href');
    const url = href ? sourceUrl(href) : null;
    const title = plainText(match[2] ?? '');
    if (title && url && !results.some((result) => result.url === url)) results.push({ title, url, snippet });
  }
  return results;
}
async function ddgLiteSearch(query: string): Promise<ProviderResult> {
  // Deployment-host probe: GET returned sources while POST returned HTTP 202
  // challenges. GET can also be challenged: do not turn that into zero results.
  const response = await request(`https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q: query })}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  }, 15_000);
  const html = await response.text();
  if (response.status === 202 || /anomaly-modal|<form[^>]*anomaly\.js|<form[^>]*(?:id|name)=["']challenge/i.test(html)) throw new SearchError('blocked', response.status);
  const results = parseDdgLiteHtml(html).slice(0, MAX_RESULTS);
  if (results.length) return { results };
  if (/class\s*=\s*["'][^"']*\bno-results\b|no results (?:found )?for\b/i.test(html)) return { results: [] };
  throw new SearchError('invalid_response');
}
async function searxngSearch(query: string, base: string): Promise<ProviderResult> {
  const response = await request(`${base.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  }, 20_000);
  const data = await response.json() as { results?: unknown; unresponsive_engines?: unknown[] };
  const results = rowsFromJson(data.results, MAX_RESULTS);
  if (!results.length && data.unresponsive_engines?.length) throw new SearchError('upstream_unavailable');
  return { results };
}
