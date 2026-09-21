// ────────────────────────────────────────
// Web search tool — StepFun MCP web_search (primary) + StepFun REST + new-api grok + SearxNG + DDG fallback
// 2026-09-21 round 132/133：主路由换成 MCP；round 133 按用户要求删掉 Gemini grounding
// （那个 key 被 Google 以「泄露」为由吊销，403 PERMISSION_DENIED）。
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const MAX_RESULTS = 5;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function executeSearch(query: string): Promise<string> {
  const e = env();
  // **全灭时必须说"全灭"，不能说"没有找到"。**
  //
  // 2026-09-21 round 123 实测：StepFun 搜索 `quota_exceeded`（429）→ Gemini 也失败
  // → 只剩 DDG Lite，而 DDG 从这台机器出去是空的。最终返回
  // `没有找到与"X"相关的结果。`——**一个基础设施故障，长得和一个合法的否定答案
  // 一模一样**。模型据此诚实地告诉用户"我没搜到"，而那是个谎：它不是没搜到，
  // 是**一条都没搜成**。
  //
  // 合龙检查也被骗了（`✗ stepfun 搜索返回带来源的结果` 看了三遍才明白是全灭）。
  // 这个会话里同类的事出过四次（round 79 terminalEnabled / round 85 打得通但不在链里 /
  // round 110 保句闸零触发 / 这次），每一次都是"失败伪装成正常输出"。
  const failedRoutes: string[] = [];

  // Route 0: StepFun 全网搜索（2026-09-20 起的主路由）。
  //
  // 为什么它是主路由而不是又一条 fallback：原来的 4 条链都要"让一个模型联网再
  // 总结一遍"，多一跳、多一类把工具标签拼进正文的泄漏面（2026-09-20 刚出过
  // <web.search><args>… 被原样发出去的事故）。stepfun 的 /v1/search 直接返回
  // title/snippet/content/time，没有模型中转，也就没有那个泄漏面。
  //
  // 默认开；STEPFUN_SEARCH_ENABLED === false 时整条跳过（repo 惯例：默认真用 === false 关）。
  //
  // 2026-09-21 round 132：`/v1/search` 那个 REST 端点 **quota_exceeded 了**
  // （round 124 实测 429），用户指了同一个账号下的 MCP 端点
  // `/step_plan/v1/mcp/web_search/mcp`，探过是通的（tools/list 返回 web_search）。
  // 所以主路由换成 MCP：JSON-RPC tools/call，参数 query/category/n/use_common_search。
  // 旧 REST 端点留着当第二顺位——配额恢复它就能用，且它返回结构更干净。
  if (e.STEPFUN_SEARCH_ENABLED !== false && e.STEPFUN_SEARCH_API_KEY) {
    try {
      return await stepfunMcpSearch(
        query,
        e.STEPFUN_SEARCH_API_KEY,
        e.STEPFUN_SEARCH_BASE_URL,
        e.STEPFUN_SEARCH_MAX_RESULTS,
        e.STEPFUN_SEARCH_CATEGORY,
      );
    } catch (err) {
      logger.warn({ err, query }, 'StepFun MCP search failed, falling back to REST');
      failedRoutes.push('StepFun-MCP');
    }
    try {
      return await stepfunSearch(
        query,
        e.STEPFUN_SEARCH_API_KEY,
        e.STEPFUN_SEARCH_BASE_URL,
        e.STEPFUN_SEARCH_MAX_RESULTS,
        e.STEPFUN_SEARCH_CATEGORY,
      );
    } catch (err) {
      logger.warn({ err, query }, 'StepFun REST search failed, falling back');
      failedRoutes.push('StepFun-REST');
    }
  }


  // Route 1: new-api grok search via search_parameters (fallback)
  if (e.XAI_API_KEY) {
    try {
      return await xaiSearch(query, e.XAI_API_KEY, e.XAI_SEARCH_BASE_URL, e.XAI_SEARCH_MODEL);
    } catch (err) {
      logger.warn({ err, query }, 'new-api search failed, falling back');
      failedRoutes.push('new-api');
    }
  }

  // Route 2: SearxNG if configured
  if (e.SEARXNG_URL) {
    return searxngSearch(query, e.SEARXNG_URL);
  }

  // Route 3: DDG Lite (always available)
  const ddg = await ddgLiteSearch(query);
  // DDG 从这台机器出去是空的（round 123 curl 实测无响应体）。它返回"没有找到"
  // 而不是抛错，所以这里补一道判据：**前面有路由失败 + DDG 也没结果 = 全灭**。
  if (failedRoutes.length > 0 && ddg.startsWith('没有找到')) {
    return `搜索全灭：${failedRoutes.join(' / ')} 都失败，DDG Lite 也无结果。`
      + `（不是"没有相关信息"，是没有任何搜索提供商可用）`;
  }
  return ddg;
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

/**
 * StepFun 全网搜索 —— **MCP 版**（2026-09-21 round 132 起的主路由）。
 *
 * 端点 `POST {base}/mcp/web_search/mcp`，JSON-RPC 2.0：
 *   {"jsonrpc":"2.0","id":1,"method":"tools/call",
 *    "params":{"name":"web_search","arguments":{"query":"…","n":5,"category":"…"}}}
 *
 * 为什么换成它：原来的 REST `/v1/search` 在 round 124 实测 `quota_exceeded`
 * （429，整条搜索链因此全灭三天）。同一个 key 下的 MCP 端点探过是通的
 * （tools/list 返回 web_search，参数 query/category/n/use_common_search）。
 *
 * 返回体和 REST 版同样处理：MCP 的 content 是 [{type:'text', text:'…'}]，
 * 拼起来再走同一套"带来源"的格式化。
 */
async function stepfunMcpSearch(
  query: string,
  apiKey: string,
  baseUrl: string,
  maxResults: number,
  category: string,
): Promise<string> {
  const base = baseUrl.replace(/\/+$/, '');
  const args: Record<string, unknown> = { query, n: Math.min(Math.max(maxResults, 1), 20) };
  if (category) args.category = category;
  const res = await fetch(`${base}/mcp/web_search/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // MCP over HTTP 要同时接受两种，否则服务端可能只回 SSE
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search', arguments: args },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`stepfun MCP search HTTP ${res.status}`);
  const data = (await res.json()) as {
    error?: { message?: string };
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  };
  if (data.error) throw new Error(`stepfun MCP search: ${data.error.message ?? 'unknown'}`);
  if (data.result?.isError) throw new Error('stepfun MCP search: tool returned isError');
  const text = (data.result?.content ?? [])
    .filter((c) => c.type === 'text' || c.type === undefined)
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
  if (!text) return '(no results)';
  // MCP 的 text 里裹着一层 JSON（{query, category, results:[{url,title,snippet,time}]}）。
  // **要解析出来再排版**，不能把原串倒给模型：那样一次搜索烧 4000 token 的括号，
  // 而模型真正要的是"标题 + 摘要 + 链接"。round 132 实测原样返回 4027 字，
  // 解析后同样内容约 800 字。
  const parsed = parseMcpResults(text);
  if (parsed.length === 0) {
    // 解析不出来（格式变了）就退回原串，但截短——别把整坨 JSON 倒出去。
    return `关于"${query}"的搜索结果：\n${text.slice(0, 1500)}`;
  }
  let out = `关于"${query}"的搜索结果：\n`;
  for (const r of parsed.slice(0, maxResults)) {
    out += `- ${r.title || '无标题'}\n  ${stripTags(r.snippet || '')}\n  ${r.url || '#'}\n`;
  }
  out += `\n    源: ${parsed.slice(0, maxResults).map((r) => r.url).filter(Boolean).join(' ')}`;
  return out;
}

interface McpResultRow { url?: string; title?: string; snippet?: string; time?: string }

/** 从 MCP 的 text 里解析出结果数组；解析不了返回 []。 */
function parseMcpResults(text: string): McpResultRow[] {
  // 兼容两种裹法：整段就是 JSON，或 JSON 前面有别的字。
  const start = text.indexOf('{');
  if (start < 0) return [];
  try {
    const d = JSON.parse(text.slice(start)) as { results?: McpResultRow[] };
    return Array.isArray(d.results) ? d.results : [];
  } catch {
    // 截断的 JSON（maxResults 太大被砍）——试着补一个 ]}
    try {
      const d = JSON.parse(`${text.slice(start).replace(/,\s*$/, '')}]}`) as { results?: McpResultRow[] };
      return Array.isArray(d.results) ? d.results : [];
    } catch {
      return [];
    }
  }
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
