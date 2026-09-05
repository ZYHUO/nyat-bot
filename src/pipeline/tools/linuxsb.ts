import { env } from '../../env.js';

export interface LinuxSbListItem {
  id: number;
  title: string;
  url: string;
  author: string;
  forum: string;
  time: string;
  pinned: boolean;
}

export interface LinuxSbPost {
  id: number;
  author: string;
  time: string;
  text: string;
}

export interface LinuxSbTopic {
  id: number;
  title: string;
  url: string;
  forum: string;
  posts: LinuxSbPost[];
}

const BASE = 'https://linux.sb';

function clampLimit(raw?: number, fallback = 8, max = 20): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function stripHtml(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<\/div\s*>/gi, '\n')
      .replace(/<\/li\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function firstText(html: string, regex: RegExp): string {
  const m = html.match(regex);
  return m?.[1] ? stripHtml(m[1]).slice(0, 300) : '';
}

export function linuxSbLatestUrl(sort = 'comment'): string {
  const s = String(sort ?? 'comment').trim().toLowerCase();
  if (s === 'featured' || s === '精华') return `${BASE}/topic_featured`;
  if (s === 'post' || s === 'new' || s === 'latest') return `${BASE}/index.php?sort=post`;
  if (s === 'lucky') return `${BASE}/index.php?sort=lucky`;
  if (s === 'card') return `${BASE}/index.php?sort=card`;
  return `${BASE}/index.php?sort=comment`;
}

export function linuxSbForumUrl(forumId: number): string {
  const id = Math.max(1, Math.floor(Number(forumId)));
  return `${BASE}/forum/${id}`;
}

export function extractLinuxSbTopicId(input: string): number | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d{1,10}$/.test(s)) return Number(s);
  try {
    const url = new URL(s);
    if (url.hostname !== 'linux.sb' && url.hostname !== 'www.linux.sb') return null;
    const m = url.pathname.match(/^\/topic\/(\d{1,10})(?:\/|$)/);
    return m?.[1] ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function parseLinuxSbList(html: string, limit = 8): LinuxSbListItem[] {
  const lim = clampLimit(limit, 8, 50);
  const out: LinuxSbListItem[] = [];
  const seen = new Set<number>();
  const itemRe = /<li\b[^>]*class=["'][^"']*post-item[^"']*["'][^>]*>[\s\S]*?<\/li>/gi;
  for (const m of html.matchAll(itemRe)) {
    const item = m[0];
    const titleTag = item.match(/<a\b[^>]*class=["'][^"']*post-title[^"']*["'][^>]*href=["'](\/topic\/\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const href = titleTag?.[1] ?? '';
    const idMatch = href.match(/^\/topic\/(\d+)$/);
    if (!idMatch?.[1]) continue;
    const id = Number(idMatch[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    const title = stripHtml(titleTag?.[2] ?? '').slice(0, 160);
    if (!title) continue;
    const author =
      stripHtml(item.match(/<a\b[^>]*href=["']\/user\/\d+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '') ||
      stripHtml(item.match(/aria-label=["']查看\s*([^"']+?)\s*的个人主页["']/i)?.[1] ?? '').slice(0, 80);
    const forum =
      stripHtml(item.match(/<a\b[^>]*class=["'][^"']*post-forum-badge[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '') ||
      stripHtml(item.match(/<span\b[^>]*class=["'][^"']*post-forum-meta[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/span>/i)?.[1] ?? '');
    const time =
      stripHtml(item.match(/<span\b[^>]*(?:data-performance-time=["']\d+["'][^>]*)>([\s\S]*?)<\/span>/i)?.[1] ?? '') ||
      stripHtml(item.match(/<span\b[^>]*class=["'][^"']*post-time[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
    out.push({
      id,
      title,
      url: `${BASE}/topic/${id}`,
      author: author.slice(0, 80),
      forum: forum.slice(0, 80),
      time: time.slice(0, 80),
      pinned: /topic-pinned|置顶/.test(item),
    });
    if (out.length >= lim) break;
  }
  return out;
}

export function parseLinuxSbTopic(html: string, url: string, limit = 8): LinuxSbTopic {
  const lim = clampLimit(limit, 8, 30);
  const id = extractLinuxSbTopicId(url) ?? 0;
  const title = firstText(html, /<h1\b[^>]*class=["'][^"']*post-content-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) || '(untitled)';
  const crumbLinks = [...html.matchAll(/<div\b[^>]*class=["'][^"']*breadcrumb[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']\/forum\/\d+["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/div>/gi)];
  const forum = crumbLinks.length ? stripHtml(crumbLinks[crumbLinks.length - 1]![1] ?? '').slice(0, 80) : '';
  const posts: LinuxSbPost[] = [];
  for (const m of html.matchAll(/<li\b[^>]*class=["'][^"']*post-entry[^"']*["'][^>]*id=["']post-(\d+)["'][^>]*>[\s\S]*?<\/li>/gi)) {
    const postHtml = m[0];
    const postId = Number(m[1]);
    const author = firstText(postHtml, /<a\b[^>]*class=["'][^"']*post-author[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const time = firstText(postHtml, /<span\b[^>]*class=["'][^"']*post-time[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const contentStart = postHtml.search(/<div\b[^>]*class=["'][^"']*post-content[^"']*["'][^>]*>/i);
    let contentHtml = contentStart >= 0 ? postHtml.slice(contentStart).replace(/^<div\b[^>]*>/i, '') : '';
    contentHtml = contentHtml
      .replace(/<button\b[^>]*class=["'][^"']*(?:long-content|fold)[^"']*["'][^>]*>[\s\S]*?<\/button>/gi, ' ')
      .replace(/<div\b[^>]*class=["'][^"']*(?:post-ops|topic-actions|post-foot)[^"']*["'][^>]*>[\s\S]*$/i, ' ');
    const text = stripHtml(contentHtml)
      .replace(/\s*(?:展开全文|收起全文|回复\s*\$?\s*点赞打赏|点赞打赏)\s*$/g, '')
      .trim()
      .slice(0, 1000);
    if (!text && !author) continue;
    posts.push({ id: postId, author: author.slice(0, 80), time: time.slice(0, 80), text });
    if (posts.length >= lim) break;
  }
  return { id, title: title.slice(0, 160), url: id ? `${BASE}/topic/${id}` : url, forum, posts };
}

async function fetchLinuxSb(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': env().WEB_FETCH_USER_AGENT || 'XXB-WebFetch/1.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`linuxsb_http_${res.status}`);
  return res.text();
}

export async function fetchLinuxSbLatest(opts?: { sort?: string; limit?: number; forumId?: number }): Promise<LinuxSbListItem[]> {
  const limit = clampLimit(opts?.limit, 8, 20);
  const url = opts?.forumId ? linuxSbForumUrl(opts.forumId) : linuxSbLatestUrl(opts?.sort);
  return parseLinuxSbList(await fetchLinuxSb(url), limit);
}

export async function fetchLinuxSbTopic(target: string, opts?: { limit?: number }): Promise<LinuxSbTopic> {
  const id = extractLinuxSbTopicId(target);
  if (!id) throw new Error('linuxsb_invalid_topic');
  const url = `${BASE}/topic/${id}`;
  return parseLinuxSbTopic(await fetchLinuxSb(url), url, clampLimit(opts?.limit, 8, 20));
}

export async function searchLinuxSb(query: string, opts?: { limit?: number }): Promise<LinuxSbListItem[]> {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) throw new Error('linuxsb_empty_query');
  const limit = clampLimit(opts?.limit, 5, 10);
  // 站内 /search 需登录；第一版扫公开最新/新帖/精华列表做本地匹配，不绕登录。
  const pools = await Promise.allSettled([
    fetchLinuxSbLatest({ sort: 'comment', limit: 50 }),
    fetchLinuxSbLatest({ sort: 'post', limit: 50 }),
    fetchLinuxSbLatest({ sort: 'featured', limit: 50 }),
  ]);
  const byId = new Map<number, LinuxSbListItem>();
  for (const r of pools) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      const hay = `${item.title} ${item.author} ${item.forum}`.toLowerCase();
      if (hay.includes(q)) byId.set(item.id, item);
    }
  }
  return [...byId.values()].slice(0, limit);
}
