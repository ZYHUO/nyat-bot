// ────────────────────────────────────────
// Web search tool — StepFun /v1/search (primary) + Gemini grounding + new-api grok + SearxNG + DDG fallback
// ────────────────────────────────────────

import { ProxyAgent } from 'undici';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const MAX_RESULTS = 5;

// 仅 Gemini 搜索走代理(本机出口地区不被 grounding 支持)。懒构造、按 URL 缓存。
let _geminiProxy: { url: string; agent: ProxyAgent } | undefined;
function geminiProxyAgent(proxyUrl: string | undefined): ProxyAgent | undefined {
  if (!proxyUrl) return undefined;
  if (_geminiProxy?.url !== proxyUrl) _geminiProxy = { url: proxyUrl, agent: new ProxyAgent(proxyUrl) };
  return _geminiProxy.agent;
}
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function executeSearch(query: string): Promise<string> {
  const e = env();

  // Route 0: StepFun 全网搜索（2026-09-20 起的主路由）。
  //
  // 为什么它是主路由而不是又一条 fallback：原来的 4 条链都要"让一个模型联网再
  // 总结一遍"，多一跳、多一类把工具标签拼进正文的泄漏面（2026-09-20 刚出过
  // <web.search><args>… 被原样发出去的事故）。stepfun 的 /v1/search 直接返回
  // title/snippet/content/time，没有模型中转，也就没有那个泄漏面。
  //
  // 默认开；STEPFUN_SEARCH_ENABLED === false 时整条跳过（repo 惯例：默认真用 === false 关）。
  if (e.STEPFUN_SEARCH_ENABLED !== false && e.STEPFUN_SEARCH_API_KEY) {
    try {
      return await stepfunSearch(
        query,
        e.STEPFUN_SEARCH_API_KEY,
        e.STEPFUN_SEARCH_BASE_URL,
        e.STEPFUN_SEARCH_MAX_RESULTS,
        e.STEPFUN_SEARCH_CATEGORY,
      );
    } catch (err) {
      logger.warn({ err, query }, 'StepFun search failed, falling back');
    }
  }

  // Route 1: Gemini Google-Search grounding (fallback)
  if (e.GEMINI_API_KEY) {
    try {
      return await geminiSearch(query, e.GEMINI_API_KEY, e.GEMINI_SEARCH_MODEL, e.GEMINI_SEARCH_PROXY);
    } catch (err) {
      logger.warn({ err, query }, 'Gemini search failed, falling back');
    }
  }

  // Route 2: new-api grok search via search_parameters (fallback)
  if (e.XAI_API_KEY) {
    try {
      return await xaiSearch(query, e.XAI_API_KEY, e.XAI_SEARCH_BASE_URL, e.XAI_SEARCH_MODEL);
    } catch (err) {
      logger.warn({ err, query }, 'new-api search failed, falling back');
    }
  }

  // Route 3: SearxNG if configured
  if (e.SEARXNG_URL) {
    return searxngSearch(query, e.SEARXNG_URL);
  }

  // Route 4: DDG Lite (always available)
  return ddgLiteSearch(query);
}

// ── StepFun 全网搜索 ──
// POST {base}/v1/search  →  { query, category, results:[{url,position,title,time,snippet,content}] }
// 注意：服务端不认 max_results（实测恒返回 10 条），所以在客户端切。
interface StepfunSearchResponse {
  query?: string;
  category?: string;
  results?: Array<{
    url?: string;
    position?: number;
    title?: string;
    time?: string;
    snippet?: string;
    content?: string;
  }>;
}

async function stepfunSearch(
  query: string,
  apiKey: string,
  baseUrl: string,
  maxResults: number,
  category: string,
): Promise<string> {
  const body: Record<string, unknown> = { query };
  if (category) body.category = category;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/search`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`stepfun search HTTP ${res.status}`);
  const data = (await res.json()) as StepfunSearchResponse;
  const rows = (data.results ?? []).slice(0, maxResults);
  if (rows.length === 0) return '(no results)';
  const lines = rows.map((r, i) => {
    const head = `[${r.position ?? i + 1}] ${r.title ?? '(无标题)'}`;
    const when = r.time ? ` (${String(r.time).slice(0, 10)})` : '';
    const src = r.url ? `\n    源: ${r.url}` : '';
    // 优先 snippet（短、已是给人看的摘要）；没有就退回 content 并截断。
    const text = (r.snippet ?? r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return `${head}${when}${src}${text ? `\n    ${text}` : ''}`;
  });
  return lines.join('\n');
}

// ── Gemini Google-Search grounding ──
// generateContent + tools:[{google_search:{}}] → 模型联网搜索后给出综合答案 +
// groundingMetadata.groundingChunks(来源)。key 走 query string(Gemini API 约定),
// 不进任何日志。

interface GeminiGroundResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
      webSearchQueries?: string[];
    };
  }>;
  error?: { message?: string };
}

async function geminiSearch(query: string, apiKey: string, model: string, proxyUrl?: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const dispatcher = geminiProxyAgent(proxyUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(30_000),
    // undici dispatcher(代理);DOM fetch 类型无此字段,故 cast
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit & { dispatcher?: ProxyAgent });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini search ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as GeminiGroundResponse;
  if (data.error) throw new Error(`Gemini search: ${data.error.message ?? 'unknown'}`);

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) return `没有找到与"${query}"相关的结果。`;

  const sources = [
    ...new Set(
      (cand?.groundingMetadata?.groundingChunks ?? [])
        .map((c) => c.web?.title?.trim())
        .filter((t): t is string => !!t),
    ),
  ].slice(0, MAX_RESULTS);

  let out = `关于"${query}"的搜索结果：\n${text}`;
  if (sources.length) out += `\n来源：${sources.join('、')}`;
  return out;
}

// ── new-api grok search (OpenAI-compatible chat/completions + search_parameters) ──

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  search_sources?: Array<{ url?: string; title?: string }>;
  annotations?: Array<{
    type?: string;
    url_citation?: { url?: string; title?: string };
  }>;
  error?: { message?: string } | string;
}

async function xaiSearch(
  query: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: query }],
      search_parameters: { mode: 'on', return_citations: true },
      stream: false,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`new-api search ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;

  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : data.error.message;
    throw new Error(`new-api search error: ${msg ?? 'unknown'}`);
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return `没有找到与"${query}"相关的结果。`;

  const sources = collectSearchSources(data);
  if (sources.length === 0) return content;

  let output = `${content}\n\n来源：\n`;
  for (const s of sources.slice(0, MAX_RESULTS)) {
    output += `- ${s.title ?? s.url}\n  ${s.url}\n`;
  }
  return output;
}

function collectSearchSources(
  data: ChatCompletionResponse,
): Array<{ url: string; title?: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string }> = [];

  for (const a of data.annotations ?? []) {
    const u = a.url_citation?.url;
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push({ url: u, title: a.url_citation?.title });
    }
  }
  for (const s of data.search_sources ?? []) {
    const u = s.url;
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push({ url: u, title: s.title });
    }
  }
  return out;
}

// ── DuckDuckGo Lite search ──

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

async function ddgLiteSearch(query: string): Promise<string> {
  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return `搜索失败: DuckDuckGo 返回 ${res.status}`;

    const html = await res.text();
    const results = parseDdgLiteHtml(html);

    if (!results.length) return `没有找到与"${query}"相关的结果。`;

    let output = `关于"${query}"的搜索结果：\n`;
    for (const r of results.slice(0, MAX_RESULTS)) {
      output += `- ${r.title}\n  ${r.snippet}\n  ${r.url}\n`;
    }
    return output;
  } catch (err) {
    logger.error({ err, query }, 'DDG Lite search failed');
    return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function parseDdgLiteHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG Lite format: <a rel="nofollow" href="URL" class='result-link'>TITLE</a>
  // followed later by <td class='result-snippet'>SNIPPET</td>
  const linkPattern = /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/g;
  const snippetPattern = /class='result-snippet'>([\s\S]*?)<\/td>/g;

  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = linkPattern.exec(html)) !== null) {
    const href = m[1];
    const titleRaw = m[2];
    if (href === undefined || titleRaw === undefined) continue;
    links.push({
      url: href,
      title: stripTags(titleRaw).trim(),
    });
  }

  const snippets: string[] = [];
  while ((m = snippetPattern.exec(html)) !== null) {
    const sn = m[1];
    snippets.push(sn === undefined ? '' : stripTags(sn).trim());
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link) continue;
    const { url, title } = link;
    const snippet = (i < snippets.length ? snippets[i] : '') ?? '';
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

// ── SearxNG search ──

async function searxngSearch(query: string, apiUrl: string): Promise<string> {
  const url = `${apiUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return `搜索失败: SearxNG 返回 ${res.status}`;

    const data = (await res.json()) as {
      results?: Array<{ title?: string; content?: string; url?: string }>;
    };
    if (!data.results?.length) return `没有找到与"${query}"相关的结果。`;

    let result = `关于"${query}"的搜索结果：\n`;
    for (const item of data.results.slice(0, MAX_RESULTS)) {
      result += `- ${item.title ?? '无标题'}\n  ${stripTags(item.content ?? '')}\n  ${item.url ?? '#'}\n`;
    }
    return result;
  } catch (err) {
    logger.error({ err, query }, 'SearxNG search failed');
    return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}
