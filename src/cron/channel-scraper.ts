// ────────────────────────────────────────
// Channel scraper — fetch public Telegram channel posts via t.me/s/
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

const LAST_ID_KEY = 'xxb:channel_scrape:last_id:';

interface ChannelPost {
  id: string;
  text: string;
}

function parseChannelPosts(html: string): ChannelPost[] {
  const posts: ChannelPost[] = [];
  // Match message blocks: data-post="channel/id" and message text
  const msgRe = /data-post=["']?[^"'\s/]+\/(\d+)["']?[\s\S]*?<div[^>]+class=["'][^"']*tgme_widget_message_text[^"']*["'][^>]*>([\s\S]*?)<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = msgRe.exec(html)) !== null) {
    const id = m[1]!;
    // Strip HTML tags, decode entities
    const text = m[2]!
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length > 20) {
      posts.push({ id, text });
    }
  }
  if (posts.length === 0 && html.length > 1000) {
    logger.debug({ htmlLen: html.length }, 'parseChannelPosts: no posts found — page structure may have changed');
  }
  return posts;
}

export async function scrapeChannel(username: string): Promise<ChannelPost[]> {
  const url = `https://t.me/s/${username}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; xxb-ts/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Channel fetch failed: ${res.status}`);
  }
  const html = await res.text();
  return parseChannelPosts(html);
}

export async function scrapeNewPosts(username: string): Promise<ChannelPost[]> {
  const redis = getRedis();
  const key = LAST_ID_KEY + username;
  const lastId = await redis.get(key);

  const posts = await scrapeChannel(username);
  if (posts.length === 0) return [];

  // Filter to only new posts
  const newPosts = lastId
    ? posts.filter((p) => Number(p.id) > Number(lastId))
    : posts.slice(-5); // First run: only take last 5

  if (newPosts.length > 0) {
    const maxId = newPosts.reduce((max, p) => (Number(p.id) > Number(max) ? p.id : max), newPosts[0]!.id);
    await redis.set(key, maxId);
    logger.info({ username, newCount: newPosts.length, maxId }, 'Channel scrape: new posts');
  }

  return newPosts;
}
