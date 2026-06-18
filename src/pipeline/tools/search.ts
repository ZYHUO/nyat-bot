// ────────────────────────────────────────
// Web search tool — xAI Responses API (primary) + DDG Lite fallback
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const MAX_RESULTS = 5;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function executeSearch(query: string): Promise<string> {
  const e = env();

  // Route 1: Gemini Google-Search grounding (primary)
  if (e.GEMINI_API_KEY) {
    try {
      return await geminiSearch(query, e.GEMINI_API_KEY, e.GEMINI_SEARCH_MODEL);
    } catch (err) {
      logger.warn({ err, query }, 'Gemini search failed, falling back');
    }
  }

  // Route 2: xAI Responses API with web_search
  if (e.XAI_API_KEY) {
    try {
      return await xaiSearch(query, e.XAI_API_KEY, e.XAI_SEARCH_MODEL);
    } catch (err) {
      logger.warn({ err, query }, 'xAI search failed, falling back');
    }
  }

  // Route 2: SearxNG if configured
  if (e.SEARXNG_URL) {
    return searxngSearch(query, e.SEARXNG_URL);
  }

  // Route 3: DDG Lite (always available)
  return ddgLiteSearch(query);
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

async function geminiSearch(query: string, apiKey: string, model: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

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

// ── xAI Responses API search ──

interface XaiResponse {
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  error?: string;
}

async function xaiSearch(query: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: query,
      tools: [{ type: 'web_search' }],
      max_output_tokens: 500,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`xAI API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as XaiResponse;

  for (const item of data.output ?? []) {
    if (item.type === 'message' && item.content) {
      for (const block of item.content) {
        if (block.type === 'output_text' && block.text) {
          return normalizeXaiSearchOutput(query, block.text);
        }
      }
    }
  }

  return `没有找到与"${query}"相关的结果。`;
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

function normalizeXaiSearchOutput(query: string, rawText: string): string {
  const unwrapped = rawText
    .replace(/^\s*<web_search>\s*/i, '')
    .replace(/\s*<\/web_search>\s*$/i, '')
    .trim();

  const withoutHeader = unwrapped
    .replace(new RegExp(`^Search results for\\s+"${escapeRegExp(query)}"\\s*:\\s*`, 'i'), '')
    .replace(/^Search results for\s+["“][\s\S]*?["”]\s*:\s*/i, '')
    .trim();

  const parsed = parseNumberedSearchResults(withoutHeader);
  if (parsed.length === 0) {
    return `关于"${query}"的搜索结果：\n${withoutHeader}`;
  }

  let output = `关于"${query}"的搜索结果：\n`;
  for (const item of parsed.slice(0, MAX_RESULTS)) {
    output += `- ${item.title}\n`;
    if (item.published) output += `  发布时间：${item.published}\n`;
    if (item.snippet) output += `  ${item.snippet}\n`;
    output += `  ${item.url}\n`;
  }
  return output;
}

function parseNumberedSearchResults(text: string): SearchResult[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized
    .split(/\n(?=\d+\.\s+Title:\s*)/g)
    .map((block) => block.trim())
    .filter(Boolean);

  const results: SearchResult[] = [];
  for (const block of blocks) {
    const title = block.match(/^\d+\.\s+Title:\s*(.+)$/im)?.[1]
      ?.replace(/^\*\*(.*)\*\*$/, '$1')
      .trim();
    const url = block.match(/^\s*URL:\s*(\S+)/im)?.[1]?.trim();
    if (!title || !url) continue;

    const published = block.match(/^\s*Published:\s*(.+)$/im)?.[1]?.trim();
    const snippet = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) =>
        line
        && !/^\d+\.\s+Title:/i.test(line)
        && !/^URL:/i.test(line)
        && !/^Published:/i.test(line)
      )
      .join(' ')
      .trim();

    results.push({
      title,
      url,
      snippet: snippet.replace(/^\*\*(.*)\*\*$/, '$1'),
      published,
    });
  }

  return results;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
