import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { resolveSandboxRoot } from '../../sandbox/paths.js';
import { env } from '../../env.js';

export interface PixivWork {
  id: string;
  title: string;
  pageUrl: string;
  thumbUrl: string;
  userId: string;
  userName: string;
  tags: string[];
  width: number;
  height: number;
  pageCount: number;
  createDate?: string;
}

export type PixivRawWork = {
  id?: string | number;
  title?: string;
  xRestrict?: number;
  url?: string;
  tags?: unknown;
  userId?: string | number;
  userName?: string;
  width?: number;
  height?: number;
  pageCount?: number;
  createDate?: string;
};

const PIXIV_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const PIXIV_REFERER = 'https://www.pixiv.net/';

function clampLimit(raw?: number, fallback = 5, max = 10): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function cleanText(v: unknown, max = 200): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function pixivSearchUrl(query: string, page = 1): string {
  const q = cleanText(query, 100);
  if (!q) throw new Error('pixiv_empty_query');
  const p = Number.isFinite(Number(page)) ? Math.max(1, Math.floor(Number(page))) : 1;
  const params = new URLSearchParams({
    word: q,
    order: 'date_d',
    mode: 'all',
    p: String(p),
    s_mode: 's_tag',
    type: 'all',
    lang: 'zh',
  });
  return `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(q)}?${params.toString()}`;
}

export function parsePixivSearchResults(rawJson: string, limit = 5): PixivWork[] {
  const lim = clampLimit(limit, 5, 50);
  const parsed = JSON.parse(rawJson) as {
    error?: boolean;
    body?: { illustManga?: { data?: PixivRawWork[] } };
  };
  if (parsed.error) throw new Error('pixiv_api_error');
  const data = parsed.body?.illustManga?.data;
  if (!Array.isArray(data)) return [];
  const out: PixivWork[] = [];
  for (const item of data) {
    const id = cleanText(item?.id, 30);
    if (!id || !/^\d+$/.test(id)) continue;
    // 只取公开全年龄；xRestrict>0 或 tags 标 R-18/R-18G 一律跳过。
    const xRestrict = Number(item?.xRestrict ?? 0);
    const tags = Array.isArray(item?.tags) ? item.tags.map((t) => cleanText(t, 60)).filter(Boolean) : [];
    if (xRestrict > 0 || tags.some((t) => /^r-?18g?$/i.test(t))) continue;
    const thumbUrl = pixivThumbUrl(item);
    if (!thumbUrl) continue;
    out.push({
      id,
      title: cleanText(item?.title, 100) || '(untitled)',
      pageUrl: `https://www.pixiv.net/artworks/${id}`,
      thumbUrl,
      userId: cleanText(item?.userId, 30),
      userName: cleanText(item?.userName, 80),
      tags: tags.slice(0, 12),
      width: Math.max(0, Number(item?.width ?? 0) || 0),
      height: Math.max(0, Number(item?.height ?? 0) || 0),
      pageCount: Math.max(1, Number(item?.pageCount ?? 1) || 1),
      createDate: item?.createDate ? String(item.createDate) : undefined,
    });
    if (out.length >= lim) break;
  }
  return out;
}

export function pixivThumbUrl(item: PixivRawWork): string {
  const url = String(item?.url ?? '');
  if (!url.startsWith('https://i.pximg.net/')) return '';
  // 250 方图 → 540 预览；custom-thumb 保持 custom1200，img-master 才换 master1200。
  return url
    .replace('/c/250x250_80_a2/', '/c/540x540_70/')
    .replace(/_square1200(\.[a-z0-9]+)$/i, '_master1200$1');
}

export function extractPixivId(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d{1,12}$/.test(s)) return s;
  try {
    const url = new URL(s);
    if (url.hostname === 'www.pixiv.net' || url.hostname === 'pixiv.net') {
      const m = url.pathname.match(/\/artworks\/(\d{1,12})(?:\/|$)/);
      if (m?.[1]) return m[1];
    }
    if (url.hostname === 'i.pximg.net') {
      const m = url.pathname.match(/\/(\d{1,12})_p\d+(?:_\w+)?\.[a-z0-9]+$/i);
      if (m?.[1]) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

async function fetchPixiv(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'user-agent': env().WEB_FETCH_USER_AGENT || PIXIV_UA,
      referer: PIXIV_REFERER,
      accept: 'application/json,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(20_000),
  });
}

export async function searchPixiv(query: string, opts?: { limit?: number }): Promise<PixivWork[]> {
  const limit = clampLimit(opts?.limit, 5, 10);
  const res = await fetchPixiv(pixivSearchUrl(query, 1));
  if (!res.ok) throw new Error(`pixiv_http_${res.status}`);
  return parsePixivSearchResults(await res.text(), limit);
}

function imageExtension(contentType: string, url: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  const ext = extname(new URL(url).pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
}

export async function downloadPixivImage(target: string): Promise<{ path: string; id: string; bytes: number }> {
  const id = extractPixivId(target);
  if (!id) throw new Error('pixiv_invalid_target');
  let imageUrl = target.startsWith('https://i.pximg.net/') ? target : '';
  if (!imageUrl) {
    // 公开作品页拿不到多图详情时，search 结果 URL 是稳定来源；先从搜索页反查这个 id。
    const res = await fetchPixiv(`https://www.pixiv.net/ajax/illust/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`pixiv_http_${res.status}`);
    const detail = JSON.parse(await res.text()) as {
      error?: boolean;
      body?: { urls?: { small?: string; regular?: string; original?: string }; xRestrict?: number };
    };
    if (detail.error || Number(detail.body?.xRestrict ?? 0) > 0) throw new Error('pixiv_unavailable_or_restricted');
    imageUrl = detail.body?.urls?.regular || detail.body?.urls?.small || '';
    if (!imageUrl.startsWith('https://i.pximg.net/')) throw new Error('pixiv_image_missing');
  }
  const res = await fetchPixiv(imageUrl);
  if (!res.ok) throw new Error(`pixiv_image_http_${res.status}`);
  const type = String(res.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('image/')) throw new Error('pixiv_not_image');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('pixiv_empty_image');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('pixiv_image_too_large');
  const dir = join(resolveSandboxRoot(), 'pixiv');
  await mkdir(dir, { recursive: true });
  const name = `${id}${imageExtension(type, imageUrl)}`;
  await writeFile(join(dir, name), bytes);
  return { path: `pixiv/${name}`, id, bytes: bytes.length };
}
