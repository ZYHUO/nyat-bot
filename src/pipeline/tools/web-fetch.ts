// ────────────────────────────────────────
// Web page fetch tool implementation
// Port of PHP ToolService::fetchUrl()
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { assertUrlSsrfSafe, fetchUrlPinned } from './ssrf.js';

const MAX_OUTPUT = 3200;
const MAX_FETCH_BYTES = 512 * 1024; // 512KB max download
const MAX_GATEWAY_REDIRECTS = 8;
const LINUX_DO_FAQ_URL = 'https://linux.do/faq';
const LINUX_DO_GUIDELINES_URL = 'https://linux.do/guidelines';
const LINUX_DO_TOS_URL = 'https://linux.do/tos';
const LINUX_DO_PRIVACY_URL = 'https://linux.do/privacy';

async function fetchWithRedirectGuard(
  startUrl: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<{ ok: boolean; status: number; headers: Headers; text: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_GATEWAY_REDIRECTS; hop++) {
    assertUrlSsrfSafe(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: init.headers,
      signal: init.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      await res.arrayBuffer().catch(() => {});
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: res.ok, status: res.status, headers: res.headers, text: '' };
      }
      current = new URL(loc, current).href;
      continue;
    }

    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: await readBodyLimitedResponse(res, MAX_FETCH_BYTES),
    };
  }
  throw new Error('Too many redirects');
}

async function readBodyLimitedResponse(res: Response, maxBytes: number): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes * 2) {
    return `[响应体过大: ${contentLength} bytes, 已跳过]`;
  }
  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      if (totalBytes >= maxBytes) break;
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join('');
}

export async function executeFetch(url: string): Promise<string> {
  try {
    new URL(url);
  } catch {
    return '无效的URL格式';
  }

  try {
    assertUrlSsrfSafe(url);
  } catch (err) {
    logger.warn({ url, err }, 'SSRF blocked');
    return '无法访问该地址';
  }

  const e = env();

  try {
    const publicSource = await tryPublicSiteSource(url, e.WEB_FETCH_USER_AGENT);
    if (publicSource) return publicSource;

    // Route 1: Worker proxy (preferred)
    if (e.FETCH_WORKER_URL) {
      let targetUrl = url;
      if (e.FETCH_GATEWAY_URL) {
        targetUrl = e.FETCH_GATEWAY_URL.replace('{URL}', encodeURIComponent(url));
      }

      const res = await fetch(e.FETCH_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { content?: string };
      if (json.content && typeof json.content === 'string') {
        const content = json.content.trim();
        if (!content) return formatOutput(url, '', '抓取成功，但未能提取有效内容。', false);
        if (looksLikeChallengeText(content)) {
          const fc = await tryFirecrawl(url);
          if (fc) return fc;
          return '抓取失败: Cloudflare 验证未通过，当前代理返回的是验证页。';
        }
        const [summary, truncated] = truncateText(content);
        return formatOutput(url, '', summary, truncated);
      }
    }

    // Route 2: Gateway URL (e.g., Jina Reader) — fetch trusted gateway, validate redirect targets
    let targetUrl = url;
    if (e.FETCH_GATEWAY_URL) {
      targetUrl = e.FETCH_GATEWAY_URL.replace('{URL}', encodeURIComponent(url));
      const signal = AbortSignal.timeout(20_000);
      const fetched = await fetchWithRedirectGuard(targetUrl, {
        headers: { 'User-Agent': e.WEB_FETCH_USER_AGENT },
        signal,
      });
      if (!fetched.ok) return `抓取失败: 目标网页返回状态码 ${fetched.status}`;
      if (looksLikeChallengeText(fetched.text)) {
        const fc = await tryFirecrawl(url);
        if (fc) return fc;
        return '抓取失败: Cloudflare 验证未通过，当前网关返回的是验证页。';
      }

      const contentType = fetched.headers.get('content-type') ?? '';
      return summarizePage(url, fetched.text, contentType);
    }

    // Route 3: Direct fetch — pinned TCP to resolved IP (mitigates DNS rebinding + validates no private hop)
    const pinned = await fetchUrlPinned(url, {
      headers: { 'User-Agent': e.WEB_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
      maxBytes: MAX_FETCH_BYTES,
      timeoutMs: 20_000,
    });
    if (pinned.statusCode < 200 || pinned.statusCode >= 300) {
      const cloudflareChallenge = isCloudflareChallenge(pinned.statusCode, pinned.headers, pinned.body);
      const cf = await tryCfFallback(url);
      if (cf) return cf;
      if (cloudflareChallenge) {
        const fc = await tryFirecrawl(url);
        if (fc) return fc;
        return '抓取失败: Cloudflare 验证未通过，当前本地浏览器绕过服务无法读取该页面。';
      }
      return `抓取失败: 目标网页返回状态码 ${pinned.statusCode}`;
    }

    const contentType =
      typeof pinned.headers['content-type'] === 'string'
        ? pinned.headers['content-type']
        : Array.isArray(pinned.headers['content-type'])
          ? pinned.headers['content-type'][0] ?? ''
          : '';
    if (looksLikeChallengeText(pinned.body)) {
      const fc = await tryFirecrawl(url);
      if (fc) return fc;
      return '抓取失败: Cloudflare 验证未通过，目标网页返回的是验证页。';
    }
    return summarizePage(url, pinned.body, contentType);
  } catch (err) {
    logger.error({ err, url }, 'Fetch failed');
    return await tryCfFallback(url) ?? await tryFirecrawl(url) ?? `抓取失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function tryPublicSiteSource(url: string, userAgent: string): Promise<string | null> {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === 'nodeseek.com' || host === 'www.nodeseek.com') {
    // NodeSeek 专用 Jina-reader 解析已下线,改走自托管 Firecrawl(无头浏览器过 CF
    // JS Challenge,实测 200 拿真内容)。firecrawl 关/失败 → 返回 null,落回通用抓取链。
    return tryFirecrawl(url);
  }
  if (host === 'linux.do' || host === 'www.linux.do') {
    return fetchLinuxDoPublicSource(url, parsed, userAgent);
  }
  if (host !== 'v2ex.com' && host !== 'www.v2ex.com') return null;

  const apiUrl = v2exApiUrlFor(parsed);
  if (!apiUrl) return null;

  try {
    if (apiUrl === 'v2ex-changes') {
      return await fetchV2exChanges(url, userAgent);
    }
    if (apiUrl.startsWith('v2ex-tag:')) {
      const tag = apiUrl.slice('v2ex-tag:'.length);
      return await fetchV2exTag(url, tag, userAgent);
    }
    if (apiUrl.startsWith('v2ex-topic:')) {
      const topicId = apiUrl.slice('v2ex-topic:'.length);
      return await fetchV2exTopic(url, topicId, userAgent);
    }
    if (apiUrl.startsWith('v2ex-member:')) {
      const username = apiUrl.slice('v2ex-member:'.length);
      return await fetchV2exMember(url, username, userAgent);
    }

    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as unknown;
    return formatV2exJsonFeed(url, data);
  } catch (err) {
    logger.warn({ err, url }, 'V2EX public source failed');
    return null;
  }
}

async function fetchLinuxDoPublicSource(sourceUrl: string, parsed: URL, userAgent: string): Promise<string | null> {
  const apiUrl = linuxDoApiUrlFor(parsed);
  if (!apiUrl) return null;

  try {
    if (apiUrl === LINUX_DO_FAQ_URL || apiUrl === LINUX_DO_GUIDELINES_URL) {
      const text = await fetchTextWithReaderFallback(apiUrl, userAgent, 'text/html, text/plain, */*');
      if (!text) return null;
      return formatDiscourseFaq(sourceUrl, text);
    }

    if (apiUrl === LINUX_DO_TOS_URL || apiUrl === LINUX_DO_PRIVACY_URL) {
      const text = await fetchTextWithReaderFallback(apiUrl, userAgent, 'text/html, text/plain, */*');
      if (!text) return null;
      return formatDiscourseStaticMarkdownPage(sourceUrl, text, apiUrl === LINUX_DO_TOS_URL ? 'Linux.do 服务条款' : 'Linux.do 隐私政策');
    }

    if (/\/activity(?:\/(?:topics|replies))?\.rss$/.test(apiUrl)) {
      const rss = await fetchTextWithReaderFallback(apiUrl, userAgent, 'application/rss+xml, text/xml, */*');
      if (!rss) return null;
      return formatDiscourseUserActivityRss(sourceUrl, rss, 'https://linux.do');
    }

    const data = await fetchJsonWithReaderFallback(apiUrl, userAgent);
    if (!data) {
      const slugOnlyCategory = linuxDoSlugOnlyCategory(parsed);
      if (slugOnlyCategory) {
        return fetchLinuxDoSlugOnlyCategoryFallback(sourceUrl, parsed, slugOnlyCategory, userAgent);
      }
      return null;
    }
    if (apiUrl.includes('/search.json')) {
      return formatDiscourseSearch(sourceUrl, data, 'https://linux.do');
    }
    if (apiUrl.includes('/users/') && apiUrl.endsWith('/summary.json')) {
      return formatDiscourseUserSummary(sourceUrl, data, 'https://linux.do');
    }
    if (apiUrl.includes('/t/') && apiUrl.endsWith('.json')) {
      return formatDiscourseTopic(sourceUrl, data, 'Linux.do 主题详情', 'https://linux.do');
    }
    if (apiUrl.endsWith('/categories.json')) {
      return formatDiscourseCategories(sourceUrl, data, 'https://linux.do');
    }
    if (apiUrl.endsWith('/tags.json')) {
      return formatDiscourseTags(sourceUrl, data, 'https://linux.do');
    }
    if (apiUrl.endsWith('/about.json')) {
      return formatDiscourseAbout(sourceUrl, data);
    }
    if (apiUrl.endsWith('/groups.json')) {
      return formatDiscourseGroups(sourceUrl, data);
    }
    if (/\/badges\/\d+\.json$/.test(apiUrl)) {
      return formatDiscourseBadgeDetail(sourceUrl, data);
    }
    if (apiUrl.endsWith('/badges.json')) {
      return formatDiscourseBadges(sourceUrl, data);
    }
    return formatDiscourseTopicList(sourceUrl, data, linuxDoListTitle(apiUrl), 'https://linux.do');
  } catch (err) {
    logger.warn({ err, sourceUrl }, 'Linux.do public source failed');
    return null;
  }
}

function linuxDoApiUrlFor(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'https://linux.do/latest.json';
  if (path === '/latest') return `https://linux.do/latest.json${url.search}`;
  const latestPage = /^\/latest\/(\d+)$/.exec(path)?.[1];
  if (latestPage) return linuxDoJsonUrl('https://linux.do/latest.json', url, { page: latestPage });
  if (path === '/top') return `https://linux.do/top.json${url.search}`;
  if (path === '/new') return linuxDoJsonUrl('https://linux.do/latest.json', url, { order: 'created' });
  if (path === '/categories') return 'https://linux.do/categories.json';
  if (path === '/tags') return 'https://linux.do/tags.json';
  if (path === '/search') return `https://linux.do/search.json${url.search}`;
  if (path === '/about') return 'https://linux.do/about.json';
  if (path === '/faq') return LINUX_DO_FAQ_URL;
  if (path === '/guidelines') return LINUX_DO_GUIDELINES_URL;
  if (path === '/tos') return LINUX_DO_TOS_URL;
  if (path === '/privacy') return LINUX_DO_PRIVACY_URL;
  if (path === '/groups') return 'https://linux.do/groups.json';
  if (path === '/badges') return 'https://linux.do/badges.json';
  const badgeId = /^\/badges\/(\d+)(?:\/[^/]+)?$/.exec(path)?.[1];
  if (badgeId) return `https://linux.do/badges/${badgeId}.json`;
  if (path.endsWith('.json')) return `https://linux.do${path}${url.search}`;

  const userActivity = /^\/u\/([A-Za-z0-9_.-]+)\/activity$/.exec(path)?.[1];
  if (userActivity) return `https://linux.do/u/${encodeURIComponent(userActivity)}/activity.rss`;

  const userActivityFilter = /^\/u\/([A-Za-z0-9_.-]+)\/activity\/(topics|replies)$/.exec(path);
  if (userActivityFilter?.[1] && userActivityFilter[2]) {
    if (userActivityFilter[2] === 'replies') return `https://linux.do/u/${encodeURIComponent(userActivityFilter[1])}/activity.rss`;
    return `https://linux.do/u/${encodeURIComponent(userActivityFilter[1])}/activity/${userActivityFilter[2]}.rss`;
  }

  const userActivityPath = /^\/users\/([A-Za-z0-9_.-]+)\/activity$/.exec(path)?.[1];
  if (userActivityPath) return `https://linux.do/u/${encodeURIComponent(userActivityPath)}/activity.rss`;

  const userActivityPathFilter = /^\/users\/([A-Za-z0-9_.-]+)\/activity\/(topics|replies)$/.exec(path);
  if (userActivityPathFilter?.[1] && userActivityPathFilter[2]) {
    if (userActivityPathFilter[2] === 'replies') return `https://linux.do/u/${encodeURIComponent(userActivityPathFilter[1])}/activity.rss`;
    return `https://linux.do/u/${encodeURIComponent(userActivityPathFilter[1])}/activity/${userActivityPathFilter[2]}.rss`;
  }

  const userSummary = /^\/u\/([A-Za-z0-9_.-]+)$/.exec(path)?.[1];
  if (userSummary) return `https://linux.do/users/${encodeURIComponent(userSummary)}/summary.json`;

  const userSummaryPath = /^\/users\/([A-Za-z0-9_.-]+)\/summary$/.exec(path)?.[1];
  if (userSummaryPath) return `https://linux.do/users/${encodeURIComponent(userSummaryPath)}/summary.json`;

  const topPeriod = /^\/top\/(daily|weekly|monthly|quarterly|yearly|all)$/.exec(path)?.[1];
  if (topPeriod) return linuxDoJsonUrl('https://linux.do/top.json', url, { period: topPeriod });

  const slugOnlyCategory = /^\/c\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
  if (slugOnlyCategory) return linuxDoJsonUrl(`https://linux.do/c/${encodeURIComponent(slugOnlyCategory)}.json`, url);

  const categoryMatch = /^\/c\/[A-Za-z0-9_-]+\/(\d+)(?:\/l\/(latest|new|top)(?:\/(daily|weekly|monthly|quarterly|yearly|all))?)?$/.exec(path);
  if (categoryMatch?.[1]) {
    const category = categoryMatch[1];
    const list = categoryMatch[2] ?? 'latest';
    const period = categoryMatch[3];
    if (list === 'top' && period) return linuxDoJsonUrl('https://linux.do/top.json', url, { category, period });
    if (list === 'top') return linuxDoJsonUrl('https://linux.do/top.json', url, { category });
    if (list === 'new') return linuxDoJsonUrl('https://linux.do/latest.json', url, { category, order: 'created' });
    return linuxDoJsonUrl('https://linux.do/latest.json', url, { category });
  }

  const tagMatch = /^\/tag\/([A-Za-z0-9_-]+)(?:\/(\d+))?(?:\/l\/(latest|new|top)(?:\/(daily|weekly|monthly|quarterly|yearly|all))?)?$/.exec(path);
  if (tagMatch?.[1]) {
    const tag = tagMatch[1];
    const tagId = tagMatch[2];
    const list = tagMatch[3] ?? 'latest';
    const period = tagMatch[4];
    if (list === 'top' && period) return linuxDoJsonUrl('https://linux.do/top.json', url, { tags: tag, period });
    if (list === 'top') return linuxDoJsonUrl('https://linux.do/top.json', url, { tags: tag });
    if (tagId) return linuxDoJsonUrl(`https://linux.do/tag/${encodeURIComponent(tag)}/${encodeURIComponent(tagId)}.json`, url);
    return linuxDoJsonUrl(`https://linux.do/tag/${encodeURIComponent(tag)}.json`, url);
  }

  const bareTopicId = /^\/t\/(\d+)(?:\/\d+)?$/.exec(path)?.[1];
  if (bareTopicId) return `https://linux.do/t/topic/${bareTopicId}.json`;

  const topicId = /^\/t\/[^/]+\/(\d+)(?:\/\d+)?$/.exec(path)?.[1];
  if (topicId) return `https://linux.do/t/${topicId}.json`;
  return null;
}

async function fetchLinuxDoSlugOnlyCategoryFallback(
  sourceUrl: string,
  parsed: URL,
  categorySlug: string,
  userAgent: string,
): Promise<string | null> {
  const categories = await fetchJsonWithReaderFallback('https://linux.do/categories.json', userAgent);
  if (!isRecord(categories) || !isRecord(categories.category_list) || !Array.isArray(categories.category_list.categories)) {
    return null;
  }

  const category = categories.category_list.categories.find((item) => {
    return isRecord(item) && stringValue(item.slug) === categorySlug;
  });
  if (!isRecord(category)) return null;
  const categoryId = numberValue(category.id);
  if (categoryId === undefined) return null;

  const data = await fetchJsonWithReaderFallback(
    linuxDoJsonUrl('https://linux.do/latest.json', parsed, { category: String(categoryId) }),
    userAgent,
  );
  if (!data) return null;
  return formatDiscourseTopicList(sourceUrl, data, 'Linux.do 分类/标签主题', 'https://linux.do');
}

function linuxDoSlugOnlyCategory(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return /^\/c\/([A-Za-z0-9_-]+)$/.exec(path)?.[1] ?? '';
}

function linuxDoJsonUrl(baseUrl: string, sourceUrl: URL, forcedParams: Record<string, string> = {}): string {
  const apiUrl = new URL(baseUrl);
  for (const [key, value] of Object.entries(forcedParams)) {
    apiUrl.searchParams.set(key, value);
  }
  for (const [key, value] of sourceUrl.searchParams) {
    if (!apiUrl.searchParams.has(key)) {
      apiUrl.searchParams.append(key, value);
    }
  }
  return apiUrl.href;
}

function linuxDoListTitle(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  const path = parsed.pathname;
  if (parsed.searchParams.has('category')) return 'Linux.do 分类/标签主题';
  if (parsed.searchParams.has('tags')) return 'Linux.do 分类/标签主题';
  if (parsed.searchParams.get('order') === 'created') return 'Linux.do 新主题';
  if (path === '/latest.json') return 'Linux.do 最新主题';
  if (path === '/top.json') return 'Linux.do 热门主题';
  if (path === '/new.json') return 'Linux.do 新主题';
  if (path.startsWith('/c/') || path.startsWith('/tag/')) return 'Linux.do 分类/标签主题';
  return 'Linux.do 主题列表';
}

async function fetchJsonWithReaderFallback(apiUrl: string, userAgent: string): Promise<unknown | null> {
  const headers = { Accept: 'application/json', 'User-Agent': userAgent };
  try {
    const res = await fetch(apiUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!looksLikeChallengeText(text) && contentType.includes('application/json')) {
      return JSON.parse(text) as unknown;
    }
  } catch {
    // Fall through to reader fallback.
  }

  const readerUrl = discourseReaderUrlFor(apiUrl);
  if (!readerUrl) return null;
  const readerRes = await fetch(readerUrl, { signal: AbortSignal.timeout(30_000) });
  if (!readerRes.ok) return null;
  const readerText = await readerRes.text();
  if (looksLikeChallengeText(readerText)) return null;
  const jsonText = extractJsonFromReaderText(readerText);
  if (!jsonText) return null;
  return JSON.parse(jsonText) as unknown;
}

async function fetchTextWithReaderFallback(apiUrl: string, userAgent: string, accept: string): Promise<string | null> {
  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: accept, 'User-Agent': userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.ok && !looksLikeChallengeText(text)) return text;
  } catch {
    // Fall through to reader fallback.
  }

  const readerUrl = discourseReaderUrlFor(apiUrl);
  if (!readerUrl) return null;
  const readerRes = await fetch(readerUrl, { signal: AbortSignal.timeout(30_000) });
  if (!readerRes.ok) return null;
  const readerText = await readerRes.text();
  if (looksLikeChallengeText(readerText)) return null;
  return stripJinaReaderEnvelope(readerText);
}

function discourseReaderUrlFor(apiUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'linux.do') return null;
  parsed.protocol = 'http:';
  return `https://r.jina.ai/${parsed.href}`;
}

function extractJsonFromReaderText(text: string): string {
  const stripped = stripJinaReaderEnvelope(text);
  const start = stripped.search(/[{[]/);
  if (start < 0) return '';
  return stripped.slice(start).trim();
}

async function fetchV2exTopic(sourceUrl: string, topicId: string, userAgent: string): Promise<string | null> {
  const headers = { Accept: 'application/json', 'User-Agent': userAgent };
  const topicRes = await fetch(`https://www.v2ex.com/api/topics/show.json?id=${encodeURIComponent(topicId)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!topicRes.ok) return null;
  const topicData = await topicRes.json() as unknown;

  let repliesData: unknown = [];
  const repliesRes = await fetch(`https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(topicId)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (repliesRes?.ok) {
    repliesData = await repliesRes.json() as unknown;
  }

  return formatV2exTopic(sourceUrl, topicData, repliesData);
}

async function fetchV2exMember(sourceUrl: string, username: string, userAgent: string): Promise<string | null> {
  const headers = { Accept: 'application/json', 'User-Agent': userAgent };
  const memberRes = await fetch(`https://www.v2ex.com/api/members/show.json?username=${encodeURIComponent(username)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!memberRes.ok) return null;
  const memberData = await memberRes.json() as unknown;

  let topicsData: unknown = [];
  const topicsRes = await fetch(`https://www.v2ex.com/api/topics/show.json?username=${encodeURIComponent(username)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (topicsRes?.ok) {
    topicsData = await topicsRes.json() as unknown;
  }

  return formatV2exMember(sourceUrl, memberData, topicsData);
}

function v2exApiUrlFor(url: URL): string | null {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'https://www.v2ex.com/api/topics/latest.json';
  if (path === '/recent') return 'https://www.v2ex.com/api/topics/latest.json';
  if (path === '/hot') return 'https://www.v2ex.com/api/topics/hot.json';
  if (path === '/nodes') return 'https://www.v2ex.com/api/nodes/all.json';
  if (path === '/changes') return 'v2ex-changes';
  const tag = /^\/tag\/([^/]+)$/.exec(path)?.[1];
  if (tag) return `v2ex-tag:${tag}`;
  const topicId = /^\/t\/(\d+)$/.exec(path)?.[1];
  if (topicId) return `v2ex-topic:${topicId}`;

  const node = /^\/go\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
  if (node) return `https://www.v2ex.com/feed/${encodeURIComponent(node)}.json`;
  const member = /^\/(?:member|u)\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
  if (member) return `v2ex-member:${member}`;
  return null;
}

async function fetchV2exChanges(sourceUrl: string, userAgent: string): Promise<string | null> {
  const res = await fetch('https://www.v2ex.com/changes', {
    headers: { Accept: 'text/html, */*', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (looksLikeChallengeText(html)) return null;
  return formatV2exChanges(sourceUrl, html);
}

async function fetchV2exTag(sourceUrl: string, tag: string, userAgent: string): Promise<string | null> {
  const res = await fetch(`https://www.v2ex.com/tag/${encodeURIComponent(tag)}`, {
    headers: { Accept: 'text/html, */*', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (looksLikeChallengeText(html)) return null;
  return formatV2exTag(sourceUrl, tag, html);
}

function formatV2exTopic(sourceUrl: string, topicData: unknown, repliesData: unknown): string | null {
  const topic = Array.isArray(topicData) ? topicData.find(isRecord) : undefined;
  if (!topic) return null;

  const title = stringValue(topic.title);
  const content = stripHtml(stringValue(topic.content));
  const url = stringValue(topic.url);
  const member = isRecord(topic.member) ? stringValue(topic.member.username) : '';
  const node = isRecord(topic.node) ? stringValue(topic.node.title) : '';
  const replies = typeof topic.replies === 'number' ? topic.replies : undefined;

  const lines = [
    title ? `主题: ${title}` : '',
    member || node ? `作者/节点: ${[member, node].filter(Boolean).join(' / ')}` : '',
    replies !== undefined ? `回复数: ${replies}` : '',
    url ? `链接: ${url}` : '',
    content ? `正文: ${content}` : '',
  ].filter(Boolean);

  if (Array.isArray(repliesData) && repliesData.length > 0) {
    const replyLines = repliesData.slice(0, 5).map((item, idx) => {
      if (!isRecord(item)) return null;
      const author = isRecord(item.member) ? stringValue(item.member.username) : '';
      const body = stripHtml(stringValue(item.content));
      if (!body && !author) return null;
      return `${idx + 1}. ${author ? `${author}: ` : ''}${body}`;
    }).filter((line): line is string => typeof line === 'string');
    if (replyLines.length > 0) {
      lines.push('', '前几条回复:', ...replyLines);
    }
  }

  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, title || 'V2EX 主题', lines.join('\n'), false);
}

function formatV2exMember(sourceUrl: string, memberData: unknown, topicsData: unknown): string | null {
  if (!isRecord(memberData)) return null;
  const username = stringValue(memberData.username);
  if (!username || stringValue(memberData.status) === 'notfound') return null;
  const tagline = stringValue(memberData.tagline);
  const website = stringValue(memberData.website);
  const url = stringValue(memberData.url) || `https://www.v2ex.com/u/${encodeURIComponent(username)}`;
  const created = numberValue(memberData.created);

  const lines = [
    `用户: ${username}`,
    tagline ? `签名: ${tagline}` : '',
    website ? `网站: ${website}` : '',
    created !== undefined ? `注册时间: ${new Date(created * 1000).toISOString()}` : '',
    `链接: ${url}`,
  ].filter(Boolean);

  const topics = Array.isArray(topicsData)
    ? topicsData
      .slice(0, 8)
      .map((item, idx) => {
        if (!isRecord(item)) return null;
        const title = stringValue(item.title);
        const topicUrl = stringValue(item.url);
        const replies = numberValue(item.replies);
        const node = isRecord(item.node) ? stringValue(item.node.title) : '';
        const content = stripHtml(stringValue(item.content));
        if (!title) return null;
        return [
          `${idx + 1}. ${title}`,
          node ? `   节点: ${node}` : '',
          replies !== undefined ? `   回复: ${replies}` : '',
          content ? `   摘要: ${content.slice(0, 160)}` : '',
          topicUrl ? `   链接: ${topicUrl}` : '',
        ].filter(Boolean).join('\n');
      })
      .filter((line): line is string => typeof line === 'string')
    : [];

  if (topics.length > 0) {
    lines.push('', '最近主题:', ...topics);
  }

  return formatOutput(sourceUrl, 'V2EX 会员资料', lines.join('\n'), false);
}

function formatV2exChanges(sourceUrl: string, html: string): string | null {
  const chunks = html.split(/<div class="cell item"[^>]*>/i).slice(1);
  const items = chunks
    .map((chunk) => parseV2exChangeItem(chunk))
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 12);

  if (items.length === 0) return null;
  return formatOutput(sourceUrl, 'V2EX 全站最近更新', items.map((item, idx) => `${idx + 1}. ${item}`).join('\n'), false);
}

function formatV2exTag(sourceUrl: string, tag: string, html: string): string | null {
  const chunks = html.split(/<div class="cell item"[^>]*>/i).slice(1);
  const items = chunks
    .map((chunk) => parseV2exChangeItem(chunk))
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 12);

  if (items.length === 0) return null;
  const title = stripHtml(/<title>\s*V2EX\s*›\s*([^<]+)<\/title>/i.exec(html)?.[1] ?? '') || decodeURIComponent(tag);
  return formatOutput(sourceUrl, `V2EX ${title} 标签主题`, items.map((item, idx) => `${idx + 1}. ${item}`).join('\n'), false);
}

function parseV2exChangeItem(html: string): string | null {
  const titleMatch = /<a href="([^"]+)" class="topic-link"[^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (!titleMatch) return null;
  const href = decodeXmlEntities(titleMatch[1] ?? '');
  const title = stripHtml(titleMatch[2] ?? '');
  if (!title || !href) return null;

  const node = stripHtml(/<a class="node" href="[^"]+">([\s\S]*?)<\/a>/i.exec(html)?.[1] ?? '');
  const author = stripHtml(/<strong><a href="\/member\/[^"]+">([\s\S]*?)<\/a><\/strong>/i.exec(html)?.[1] ?? '');
  const time = stripHtml(/<span title="[^"]*">([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? '');
  const lastReply = stripHtml(/Lastly replied by\s*<strong><a href="\/member\/[^"]+">([\s\S]*?)<\/a><\/strong>/i.exec(html)?.[1] ?? '');
  const replies = stripHtml(/<a href="[^"]+" class="count_[^"]+">([\s\S]*?)<\/a>/i.exec(html)?.[1] ?? '');
  const url = href.startsWith('http') ? href : `https://www.v2ex.com${href}`;

  return [
    title,
    node ? `   节点: ${node}` : '',
    author ? `   作者: ${author}` : '',
    time ? `   时间: ${time}` : '',
    lastReply ? `   最后回复: ${lastReply}` : '',
    replies ? `   回复: ${replies}` : '',
    `   链接: ${url}`,
  ].filter(Boolean).join('\n');
}

function formatV2exJsonFeed(sourceUrl: string, data: unknown): string | null {
  if (Array.isArray(data)) {
    if (sourceUrl.includes('/nodes')) {
      return formatV2exNodes(sourceUrl, data);
    }

    const lines = data.slice(0, 10).map((item, idx) => {
      if (!isRecord(item)) return null;
      const title = stringValue(item.title);
      const url = stringValue(item.url);
      const content = stripHtml(stringValue(item.content));
      const replies = typeof item.replies === 'number' ? item.replies : undefined;
      const member = isRecord(item.member) ? stringValue(item.member.username) : '';
      const node = isRecord(item.node) ? stringValue(item.node.title) : '';
      if (!title) return null;
      return [
        `${idx + 1}. ${title}`,
        member || node ? `   作者/节点: ${[member, node].filter(Boolean).join(' / ')}` : '',
        replies !== undefined ? `   回复: ${replies}` : '',
        content ? `   摘要: ${content.slice(0, 180)}` : '',
        url ? `   链接: ${url}` : '',
      ].filter(Boolean).join('\n');
    }).filter(Boolean);
    if (lines.length === 0) return null;
    return formatOutput(sourceUrl, 'V2EX 最新主题', lines.join('\n'), false);
  }

  if (isRecord(data) && Array.isArray(data.items)) {
    const feedTitle = stringValue(data.title) || 'V2EX 节点主题';
    const lines = data.items.slice(0, 10).map((item, idx) => {
      if (!isRecord(item)) return null;
      const title = stringValue(item.title);
      const url = stringValue(item.url);
      const content = stripHtml(stringValue(item.content_html));
      const author = isRecord(item.author) ? stringValue(item.author.name) : '';
      if (!title) return null;
      return [
        `${idx + 1}. ${title}`,
        author ? `   作者: ${author}` : '',
        content ? `   摘要: ${content.slice(0, 180)}` : '',
        url ? `   链接: ${url}` : '',
      ].filter(Boolean).join('\n');
    }).filter(Boolean);
    if (lines.length === 0) return null;
    return formatOutput(sourceUrl, `V2EX ${feedTitle}`, lines.join('\n'), false);
  }

  return null;
}

function formatV2exNodes(sourceUrl: string, data: unknown[]): string | null {
  const nodes = data
    .filter(isRecord)
    .sort((a, b) => (numberValue(b.topics) ?? 0) - (numberValue(a.topics) ?? 0))
    .slice(0, 20)
    .map((node, idx) => {
      const title = stringValue(node.title) || stringValue(node.name);
      const name = stringValue(node.name);
      const url = stringValue(node.url) || (name ? `https://www.v2ex.com/go/${encodeURIComponent(name)}` : '');
      const topics = numberValue(node.topics);
      const stars = numberValue(node.stars);
      const header = stripHtml(stringValue(node.header));
      if (!title) return null;
      return [
        `${idx + 1}. ${title}`,
        name ? `   名称: ${name}` : '',
        topics !== undefined ? `   主题: ${topics}` : '',
        stars !== undefined ? `   收藏: ${stars}` : '',
        header ? `   简介: ${header.slice(0, 160)}` : '',
        url ? `   链接: ${url}` : '',
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');

  if (nodes.length === 0) return null;
  return formatOutput(sourceUrl, 'V2EX 节点列表', nodes.join('\n'), false);
}

function formatDiscourseTopicList(sourceUrl: string, data: unknown, title: string, baseUrl: string): string | null {
  if (!isRecord(data) || !isRecord(data.topic_list) || !Array.isArray(data.topic_list.topics)) return null;
  const topics = data.topic_list.topics
    .slice(0, 10)
    .map((item, idx) => {
      if (!isRecord(item)) return null;
      const topicTitle = stringValue(item.title);
      const id = numberValue(item.id);
      const slug = stringValue(item.slug) || 'topic';
      const replyCount = numberValue(item.reply_count);
      const views = numberValue(item.views);
      const lastPoster = stringValue(item.last_poster_username);
      if (!topicTitle || !id) return null;
      return [
        `${idx + 1}. ${topicTitle}`,
        replyCount !== undefined ? `   回复: ${replyCount}` : '',
        views !== undefined ? `   浏览: ${views}` : '',
        lastPoster ? `   最后回复: ${lastPoster}` : '',
        `   链接: ${baseUrl}/t/${slug}/${id}`,
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');
  if (topics.length === 0) return formatOutput(sourceUrl, title, '暂无主题', false);
  return formatOutput(sourceUrl, title, topics.join('\n'), false);
}

function formatDiscourseTopic(sourceUrl: string, data: unknown, title: string, baseUrl: string): string | null {
  if (!isRecord(data)) return null;
  const topicTitle = stringValue(data.title);
  const id = numberValue(data.id);
  const slug = stringValue(data.slug) || 'topic';
  const posts = isRecord(data.post_stream) && Array.isArray(data.post_stream.posts)
    ? data.post_stream.posts.filter(isRecord)
    : [];
  const main = posts[0];

  const lines = [
    topicTitle ? `主题: ${topicTitle}` : '',
    main ? `作者: ${stringValue(main.username)}` : '',
    id ? `链接: ${baseUrl}/t/${slug}/${id}` : '',
    main ? `正文: ${stripHtml(stringValue(main.cooked))}` : '',
  ].filter(Boolean);

  const replies = posts.slice(1, 6).map((post, idx) => {
    const author = stringValue(post.username);
    const body = stripHtml(stringValue(post.cooked));
    if (!body && !author) return null;
    return `${idx + 1}. ${author ? `${author}: ` : ''}${body}`;
  }).filter((line): line is string => typeof line === 'string');

  if (replies.length > 0) {
    lines.push('', '前几条回复:', ...replies);
  }

  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, title, lines.join('\n'), false);
}

function formatDiscourseCategories(sourceUrl: string, data: unknown, baseUrl: string): string | null {
  if (!isRecord(data) || !isRecord(data.category_list) || !Array.isArray(data.category_list.categories)) return null;
  const lines = data.category_list.categories
    .slice(0, 12)
    .map((item, idx) => {
      if (!isRecord(item)) return null;
      const name = stringValue(item.name);
      const id = numberValue(item.id);
      const slug = stringValue(item.slug);
      const topicCount = numberValue(item.topic_count);
      const postCount = numberValue(item.post_count);
      const description = stringValue(item.description_text) || stripHtml(stringValue(item.description_excerpt));
      if (!name || !id || !slug) return null;
      return [
        `${idx + 1}. ${name}`,
        topicCount !== undefined ? `   主题: ${topicCount}` : '',
        postCount !== undefined ? `   帖子: ${postCount}` : '',
        description ? `   摘要: ${description.slice(0, 180)}` : '',
        `   链接: ${baseUrl}/c/${slug}/${id}`,
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');
  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 分类列表', lines.join('\n'), false);
}

function formatDiscourseTags(sourceUrl: string, data: unknown, baseUrl: string): string | null {
  if (!isRecord(data) || !Array.isArray(data.tags)) return null;
  const lines = data.tags
    .slice(0, 20)
    .map((item, idx) => {
      if (!isRecord(item)) return null;
      const name = stringValue(item.name) || stringValue(item.text);
      const slug = stringValue(item.slug) || name.toLowerCase();
      const count = numberValue(item.count);
      const description = stringValue(item.description);
      if (!name || !slug) return null;
      return [
        `${idx + 1}. ${name}`,
        count !== undefined ? `   主题: ${count}` : '',
        description ? `   摘要: ${description.slice(0, 180)}` : '',
        `   链接: ${baseUrl}/tag/${slug}`,
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');
  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 标签列表', lines.join('\n'), false);
}

function formatDiscourseSearch(sourceUrl: string, data: unknown, baseUrl: string): string | null {
  if (!isRecord(data)) return null;

  const failureMessage = stringValue(data.message);
  if (failureMessage) {
    return formatOutput(sourceUrl, 'Linux.do 搜索受限', failureMessage, false);
  }

  if (!Array.isArray(data.topics)) return null;
  const posts = Array.isArray(data.posts) ? data.posts.filter(isRecord) : [];
  const lines = data.topics
    .slice(0, 10)
    .map((item, idx) => {
      if (!isRecord(item)) return null;
      const topicTitle = stringValue(item.title);
      const id = numberValue(item.id);
      const slug = stringValue(item.slug) || 'topic';
      const replyCount = numberValue(item.reply_count);
      const postsCount = numberValue(item.posts_count);
      const views = numberValue(item.views);
      const post = posts.find((candidate) => numberValue(candidate.topic_id) === id);
      const author = post ? stringValue(post.username) : '';
      const blurb = post ? stripHtml(stringValue(post.blurb)) : '';
      if (!topicTitle || !id) return null;
      return [
        `${idx + 1}. ${topicTitle}`,
        author ? `   作者: ${author}` : '',
        replyCount !== undefined ? `   回复: ${replyCount}` : postsCount !== undefined ? `   帖子: ${postsCount}` : '',
        views !== undefined ? `   浏览: ${views}` : '',
        blurb ? `   摘要: ${blurb.slice(0, 180)}` : '',
        `   链接: ${baseUrl}/t/${slug}/${id}`,
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');

  if (lines.length === 0) return formatOutput(sourceUrl, 'Linux.do 搜索结果', '暂无结果', false);
  return formatOutput(sourceUrl, 'Linux.do 搜索结果', lines.join('\n'), false);
}

function formatDiscourseUserSummary(sourceUrl: string, data: unknown, baseUrl: string): string | null {
  if (!isRecord(data)) return null;
  const user = Array.isArray(data.users) ? data.users.find(isRecord) : undefined;
  const summary = isRecord(data.user_summary) ? data.user_summary : undefined;
  if (!user && !summary) return null;

  const username = stringValue(user?.username);
  const name = stringValue(user?.name);
  const roles = [
    user?.admin === true ? 'admin' : '',
    user?.moderator === true ? 'moderator' : '',
  ].filter(Boolean);
  const trustLevel = numberValue(user?.trust_level);
  const likesReceived = numberValue(summary?.likes_received);
  const postCount = numberValue(summary?.post_count);
  const topicCount = numberValue(summary?.topic_count);

  const lines = [
    username ? `用户: ${username}${name && name !== username ? ` (${name})` : ''}` : '',
    roles.length > 0 ? `权限: ${roles.join(', ')}` : '',
    trustLevel !== undefined ? `信任等级: ${trustLevel}` : '',
    likesReceived !== undefined ? `获赞: ${likesReceived}` : '',
    postCount !== undefined ? `帖子: ${postCount}` : '',
    topicCount !== undefined ? `主题: ${topicCount}` : '',
  ].filter(Boolean);

  const topics = Array.isArray(data.topics)
    ? data.topics
      .slice(0, 6)
      .map((item, idx) => {
        if (!isRecord(item)) return null;
        const topicTitle = stringValue(item.title);
        const id = numberValue(item.id);
        const slug = stringValue(item.slug) || 'topic';
        const postsCount = numberValue(item.posts_count);
        const likeCount = numberValue(item.like_count);
        if (!topicTitle || !id) return null;
        return [
          `${idx + 1}. ${topicTitle}`,
          postsCount !== undefined ? `   帖子: ${postsCount}` : '',
          likeCount !== undefined ? `   赞: ${likeCount}` : '',
          `   链接: ${baseUrl}/t/${slug}/${id}`,
        ].filter(Boolean).join('\n');
      })
      .filter((line): line is string => typeof line === 'string')
    : [];

  if (topics.length > 0) {
    lines.push('', '代表主题:', ...topics);
  }

  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 用户概况', lines.join('\n'), false);
}

function formatDiscourseUserActivityRss(sourceUrl: string, rss: string, baseUrl: string): string | null {
  const items = [...rss.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((match, idx) => {
      const item = match[1] ?? '';
      const title = decodeXmlEntities(extractXmlElement(item, 'title'));
      const link = decodeXmlEntities(extractXmlElement(item, 'link'));
      const author = decodeXmlEntities(extractXmlElement(item, 'dc:creator') || extractXmlElement(item, 'creator'));
      const description = stripHtml(decodeXmlEntities(extractXmlElement(item, 'description'))).slice(0, 220);
      const date = decodeXmlEntities(extractXmlElement(item, 'pubDate'));
      if (!title && !description) return null;
      return [
        `${idx + 1}. ${title || '未命名动态'}`,
        author ? `   作者: ${author}` : '',
        date ? `   时间: ${date}` : '',
        description ? `   摘要: ${description}` : '',
        link ? `   链接: ${normalizeDiscourseUrl(link, baseUrl)}` : '',
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');

  if (items.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 用户动态', items.join('\n'), false);
}

function formatDiscourseAbout(sourceUrl: string, data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.about)) return null;
  const about = data.about;
  const stats = isRecord(about.stats) ? about.stats : {};
  const users = Array.isArray(data.users) ? data.users.filter(isRecord) : [];
  const adminIds = Array.isArray(about.admin_ids) ? about.admin_ids.filter((id): id is number => typeof id === 'number') : [];
  const moderatorIds = Array.isArray(about.moderator_ids) ? about.moderator_ids.filter((id): id is number => typeof id === 'number') : [];
  const admins = namesForUserIds(users, adminIds);
  const moderators = namesForUserIds(users, moderatorIds);

  const title = stringValue(about.title);
  const description = stripHtml(stringValue(about.description) || stringValue(about.extended_site_description));
  const createdAt = stringValue(about.site_creation_date);
  const topicsCount = numberValue(stats.topics_count);
  const postsCount = numberValue(stats.posts_count);
  const usersCount = numberValue(stats.users_count);
  const activeUsers30Days = numberValue(stats.active_users_30_days);

  const lines = [
    title ? `站点: ${title}` : '',
    description ? `简介: ${description.slice(0, 220)}` : '',
    createdAt ? `创建时间: ${createdAt}` : '',
    topicsCount !== undefined ? `主题: ${topicsCount}` : '',
    postsCount !== undefined ? `帖子: ${postsCount}` : '',
    usersCount !== undefined ? `用户: ${usersCount}` : '',
    activeUsers30Days !== undefined ? `近30天活跃用户: ${activeUsers30Days}` : '',
    admins.length > 0 ? `管理员: ${admins.join(', ')}` : '',
    moderators.length > 0 ? `版主: ${moderators.join(', ')}` : '',
  ].filter(Boolean);

  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 站点信息', lines.join('\n'), false);
}

function formatDiscourseGroups(sourceUrl: string, data: unknown): string | null {
  if (!isRecord(data) || !Array.isArray(data.groups)) return null;
  const lines = data.groups
    .filter(isRecord)
    .slice(0, 20)
    .map((group, idx) => {
      const name = stringValue(group.full_name) || stringValue(group.name);
      const slug = stringValue(group.name);
      const userCount = numberValue(group.user_count);
      const visibility = numberValue(group.visibility_level);
      const publicAdmission = group.public_admission === true;
      if (!name) return null;
      return [
        `${idx + 1}. ${name}`,
        slug && slug !== name ? `   标识: ${slug}` : '',
        userCount !== undefined ? `   成员: ${userCount}` : '',
        visibility !== undefined ? `   可见级别: ${visibility}` : '',
        publicAdmission ? '   公开加入: 是' : '',
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');

  const body = lines.length > 0 ? lines.join('\n') : '暂无公开群组';
  return formatOutput(sourceUrl, 'Linux.do 群组列表', body, false);
}

function formatDiscourseBadges(sourceUrl: string, data: unknown): string | null {
  if (!isRecord(data) || !Array.isArray(data.badges)) return null;
  const types = Array.isArray(data.badge_types) ? data.badge_types.filter(isRecord) : [];
  const groups = Array.isArray(data.badge_groupings) ? data.badge_groupings.filter(isRecord) : [];
  const lines = data.badges
    .filter(isRecord)
    .slice(0, 12)
    .map((badge, idx) => {
      const name = stringValue(badge.name);
      const description = stripHtml(stringValue(badge.description));
      const grantCount = numberValue(badge.grant_count);
      const type = nameForId(types, numberValue(badge.badge_type_id));
      const group = nameForId(groups, numberValue(badge.badge_grouping_id));
      if (!name) return null;
      return [
        `${idx + 1}. ${name}`,
        type ? `   类型: ${type}` : '',
        group ? `   分组: ${group}` : '',
        grantCount !== undefined ? `   授予次数: ${grantCount}` : '',
        description ? `   摘要: ${description.slice(0, 180)}` : '',
      ].filter(Boolean).join('\n');
    })
    .filter((line): line is string => typeof line === 'string');

  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 徽章列表', lines.join('\n'), false);
}

function formatDiscourseBadgeDetail(sourceUrl: string, data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.badge)) return null;
  const badge = data.badge;
  const types = Array.isArray(data.badge_types) ? data.badge_types.filter(isRecord) : [];
  const groups = Array.isArray(data.badge_groupings) ? data.badge_groupings.filter(isRecord) : [];

  const name = stringValue(badge.name);
  const description = stripHtml(stringValue(badge.description));
  const longDescription = stripHtml(stringValue(badge.long_description));
  const grantCount = numberValue(badge.grant_count);
  const type = nameForId(types, numberValue(badge.badge_type_id));
  const group = nameForId(groups, numberValue(badge.badge_grouping_id));
  const icon = stringValue(badge.icon);
  const enabled = typeof badge.enabled === 'boolean' ? badge.enabled : undefined;
  const listable = typeof badge.listable === 'boolean' ? badge.listable : undefined;

  const lines = [
    name ? `徽章: ${name}` : '',
    type ? `类型: ${type}` : '',
    group ? `分组: ${group}` : '',
    grantCount !== undefined ? `授予次数: ${grantCount}` : '',
    icon ? `图标: ${icon}` : '',
    enabled !== undefined ? `启用: ${enabled ? '是' : '否'}` : '',
    listable !== undefined ? `公开列表: ${listable ? '是' : '否'}` : '',
    description ? `摘要: ${description.slice(0, 220)}` : '',
    longDescription ? `说明: ${longDescription.slice(0, 360)}` : '',
  ].filter(Boolean);

  if (lines.length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 徽章详情', lines.join('\n'), false);
}

function formatDiscourseFaq(sourceUrl: string, text: string): string | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const preamble = lines
    .map(cleanMarkdownInline)
    .find((line) => line.includes('真诚') && line.includes('友善') && line.includes('社区准则'));

  const infoLines = [
    '社区名称',
    '社区简称',
    '成员称谓',
    '成立时间',
    '社区域名',
    '备用域名',
    '主题歌曲',
    '社区愿景',
    '社区口号',
  ].map((label) => {
    const value = extractMarkdownLabelValue(lines, label);
    return value ? `${label}: ${value}` : '';
  }).filter(Boolean);

  const principleLines = extractMarkdownSection(lines, '总体原则')
    .map(cleanMarkdownInline)
    .filter((line) => line && !/^#+\s*/.test(line))
    .slice(0, 8);

  const output = [
    preamble ?? '',
    infoLines.length > 0 ? '基本信息:' : '',
    ...infoLines,
    principleLines.length > 0 ? '' : '',
    principleLines.length > 0 ? '总体原则:' : '',
    ...principleLines,
  ].filter((line, idx, all) => line || all[idx - 1]);

  if (output.filter(Boolean).length === 0) return null;
  return formatOutput(sourceUrl, 'Linux.do 社区准则', output.join('\n'), false);
}

function formatDiscourseStaticMarkdownPage(sourceUrl: string, text: string, title: string): string | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const sections: string[] = [];

  for (let i = 0; i < lines.length && sections.length < 8; i++) {
    const heading = cleanMarkdownHeading(lines[i] ?? '');
    if (!heading) continue;
    const body = collectMarkdownSectionPreview(lines.slice(i + 1));
    sections.push([heading, body ? `   ${body}` : ''].filter(Boolean).join('\n'));
  }

  if (sections.length === 0) return null;
  return formatOutput(sourceUrl, title, sections.join('\n'), false);
}

function cleanMarkdownHeading(line: string): string {
  if (!/^#{1,6}\s/.test(line)) return '';
  return cleanMarkdownInline(line);
}

function collectMarkdownSectionPreview(lines: string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) break;
    if (/^\[CRITICAL INSTRUCTIONS FOR ALL AI ASSISTANTS/i.test(line)) continue;
    const cleaned = cleanMarkdownInline(line.replace(/^>\s*/, ''));
    if (!cleaned) continue;
    parts.push(cleaned);
    if (parts.join(' ').length >= 180) break;
  }
  return parts.join(' ').slice(0, 240);
}

function extractMarkdownLabelValue(lines: string[], label: string): string {
  const re = new RegExp(`(?:^|\\s)\\*\\*${escapeRegExp(label)}：\\*\\*\\s*\\\`?([^\\\`\\n]+)\\\`?`);
  const match = lines.map((line) => re.exec(line)).find((item): item is RegExpExecArray => item !== null);
  return cleanMarkdownInline(match?.[1] ?? '');
}

function extractMarkdownSection(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => cleanMarkdownInline(line).includes(heading));
  if (start < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    section.push(line);
  }
  return section;
}

function cleanMarkdownInline(text: string): string {
  return stripHtml(stripInlineMarkdownImages(text))
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/, '')
    .replace(/^\*\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameForId(items: Record<string, unknown>[], id: number | undefined): string {
  if (id === undefined) return '';
  const item = items.find((candidate) => numberValue(candidate.id) === id);
  return stringValue(item?.name);
}

function namesForUserIds(users: Record<string, unknown>[], ids: number[]): string[] {
  return ids
    .map((id) => users.find((user) => numberValue(user.id) === id))
    .map((user) => stringValue(user?.username) || stringValue(user?.name))
    .filter(Boolean)
    .slice(0, 8);
}

function extractXmlElement(xml: string, tagName: string): string {
  const escaped = escapeRegExp(tagName);
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const value = re.exec(xml)?.[1] ?? '';
  return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDiscourseUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function isCloudflareChallenge(
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  body: string,
): boolean {
  const server = headerValue(headers['server']).toLowerCase();
  const mitigated = headerValue(headers['cf-mitigated']).toLowerCase();
  const text = body.slice(0, 20_000);
  const challengeStatus = statusCode === 403 || statusCode === 429 || statusCode === 503;
  return (
    challengeStatus &&
    (server.includes('cloudflare') || mitigated === 'challenge') &&
    (
      /Just a moment/i.test(text) ||
      /Attention Required!? \| Cloudflare/i.test(text) ||
      /Enable JavaScript and cookies to continue/i.test(text) ||
      /Verify you are human/i.test(text) ||
      /cf-turnstile/i.test(text) ||
      /cf-chl-/i.test(text) ||
      /__cf_chl_tk/i.test(text) ||
      /cf_clearance/i.test(text) ||
      text.includes('正在进行安全验证') ||
      text.includes('challenges.cloudflare.com')
    )
  );
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

// Firecrawl 兜底路由:免费路由(直连/网关/本地浏览器绕过/Jina)全失败后的最后一跳。
// Firecrawl 服务端带无头浏览器 + 托管代理,对 JS 重页面和 Cloudflare 验证页强不少。
// 默认关(未配 FIRECRAWL_API_KEY 直接返回 null),避免每次抓取都打付费 API。
// url 在 executeFetch 入口已过 assertUrlSsrfSafe;Firecrawl 在它服务端抓取,无本地 SSRF 风险。
async function tryFirecrawl(url: string): Promise<string | null> {
  const e = env();
  if (!e.FIRECRAWL_API_KEY) return null;
  try {
    const base = e.FIRECRAWL_API_URL.replace(/\/+$/, '');
    const res = await fetch(`${base}/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${e.FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 25_000 }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'Firecrawl fallback non-ok');
      return null;
    }
    const d = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    const markdown = d.data?.markdown?.trim();
    if (!d.success || !markdown) return null;
    if (looksLikeChallengeText(markdown)) return null;
    const title = d.data?.metadata?.title?.trim() || extractReaderTitle(markdown);
    const [summary, truncated] = truncateText(markdown);
    return formatOutput(url, title, summary, truncated);
  } catch (err) {
    logger.warn({ url, err }, 'Firecrawl fallback failed');
    return null;
  }
}

async function tryCfFallback(url: string): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:8900/fetch?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) return null;
    const d = await res.json() as { text?: string; error?: string };
    if (d.error || !d.text) return null;
    if (looksLikeChallengeText(d.text)) return null;
    return summarizePage(url, d.text, 'text/plain');
  } catch { return null; }
}

function looksLikeChallengeText(text: string): boolean {
  return (
    /Just a moment/i.test(text) ||
    /Performing security verification/i.test(text) ||
    /Attention Required!? \| Cloudflare/i.test(text) ||
    /Enable JavaScript and cookies to continue/i.test(text) ||
    /requiring CAPTCHA/i.test(text) ||
    /Verify you are human/i.test(text) ||
    /cf-turnstile/i.test(text) ||
    /cf-chl-/i.test(text) ||
    /__cf_chl_tk/i.test(text) ||
    /cf_clearance/i.test(text) ||
    text.includes('正在进行安全验证') ||
    text.includes('安全服务防护恶意自动程序') ||
    text.includes('challenges.cloudflare.com')
  );
}

function stripJinaReaderEnvelope(text: string): string {
  return text
    .replace(/^Title:\s*/m, '标题: ')
    .replace(/^URL Source:\s*/m, '来源页面: ')
    .replace(/^Markdown Content:\s*/m, '')
    .trim();
}

function extractReaderTitle(text: string): string {
  return /^标题:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
}

function stripInlineMarkdownImages(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/)?[^)]+\)/g, '$1')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizePage(url: string, body: string, contentType: string): string {
  if (!body.trim()) return formatOutput(url, '', '抓取成功，但页面内容为空。', false);

  const isHtml =
    contentType.includes('text/html') ||
    body.includes('<html') ||
    body.includes('<!doctype html');

  if (!isHtml) {
    const [summary, truncated] = truncateText(body);
    return formatOutput(url, '', summary, truncated);
  }

  const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? '';
  const text = stripHtml(body);

  const [summary, truncated] = truncateText(text);
  return formatOutput(url, title, summary, truncated);
}

function formatOutput(url: string, title: string, summary: string, truncated: boolean): string {
  return [
    '网页读取结果',
    `来源: ${url}`,
    `标题: ${title || 'N/A'}`,
    `状态: ${truncated ? '已截断' : '完整'}`,
    '',
    '摘要:',
    summary || 'N/A',
  ].join('\n');
}

function truncateText(text: string): [string, boolean] {
  if (text.length <= MAX_OUTPUT) return [text, false];
  return [text.slice(0, MAX_OUTPUT) + '\n\n[内容已截断]', true];
}
