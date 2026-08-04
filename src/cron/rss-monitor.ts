// ────────────────────────────────────────
// P2-B: RSS 信息流监控
// ────────────────────────────────────────
//
// 周期轮询 RSS/Atom feeds，解析新条目：
// - 存入 Redis list `xxb:rss:fuel:{chatId}` 供主动搭话引用（谈资）
// - autoPost=true 的 feed 直接发到指定群（带 bot 风格评论）
//
// env 配置:
//   RSS_MONITOR_ENABLED=true
//   RSS_FEEDS_JSON='[{"url":"...","chatId":-100...,"autoPost":true,"sourceName":"Hacker News"}]'
//   RSS_MONITOR_INTERVAL_MIN=30
//
// 去重：用 feed URL + item guid/link 的 MD5 作为 Redis set 成员。

import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { XMLParser } from 'fast-xml-parser';
import { StreamingSender } from '../bot/sender/streaming.js';
import { callWithFallback } from '../ai/fallback.js';
import { createHash } from 'node:crypto';

const SEEN_PREFIX = 'xxb:rss:seen:';       // Set: 已推送条目的 fingerprint
const FUEL_PREFIX = 'xxb:rss:fuel:';       // List: 供主动搭话引用的谈资
const FUEL_MAX_LEN = 10;                    // 每群最多保留 10 条谈资
const SEEN_TTL_SEC = 7 * 86400;            // 7 天去重窗口
const FETCH_TIMEOUT_MS = 15000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
});

interface RssFeedConfig {
  url: string;
  chatId: number;
  autoPost?: boolean;
  sourceName?: string;
}

interface RssItem {
  title: string;
  link?: string;
  description?: string;
  pubDate?: string;
  guid?: string;
}

function parseFeedsConfig(json: string): RssFeedConfig[] {
  try {
    const arr = JSON.parse(json) as unknown[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        url: String(x['url'] ?? ''),
        chatId: Number(x['chatId'] ?? 0),
        autoPost: Boolean(x['autoPost'] ?? false),
        sourceName: typeof x['sourceName'] === 'string' ? x['sourceName'] : undefined,
      }))
      .filter((f) => f.url && f.chatId);
  } catch {
    return [];
  }
}

/** 从 RSS/Atom XML 中提取条目 */
function extractItems(xml: string): RssItem[] {
  try {
    const doc = xmlParser.parse(xml) as Record<string, unknown>;

    // RSS 2.0: rss > channel > item[]
    const rssChannel = (doc['rss'] as Record<string, unknown> | undefined)?.['channel'] as
      | Record<string, unknown>
      | undefined;
    if (rssChannel) {
      const items = rssChannel['item'];
      if (!items) return [];
      const itemArr = Array.isArray(items) ? items : [items];
      return itemArr.map((raw) => {
        const r = raw as Record<string, unknown>;
        const title = r['title'] as string | undefined;
        const link = r['link'] as string | undefined;
        const description = r['description'] as string | undefined;
        const pubDate = r['pubDate'] as string | undefined;
        const guid = r['guid'] as string | undefined;
        return {
          title: title ?? '(无标题)',
          link: typeof link === 'string' ? link : undefined,
          description: typeof description === 'string' ? description : undefined,
          pubDate: typeof pubDate === 'string' ? pubDate : undefined,
          guid: typeof guid === 'string' ? guid : undefined,
        };
      });
    }

    // Atom: feed > entry[]
    const atomFeed = doc['feed'] as Record<string, unknown> | undefined;
    if (atomFeed) {
      const entries = atomFeed['entry'];
      if (!entries) return [];
      const entryArr = Array.isArray(entries) ? entries : [entries];
      return entryArr.map((raw) => {
        const r = raw as Record<string, unknown>;
        const title = r['title'] as string | undefined;
        const linkEl = r['link'] as Record<string, unknown> | undefined;
        const link = linkEl?.['@_href'] as string | undefined;
        const summary = r['summary'] as string | undefined;
        const updated = r['updated'] as string | undefined;
        const id = r['id'] as string | undefined;
        return {
          title: title ?? '(无标题)',
          link: typeof link === 'string' ? link : undefined,
          description: typeof summary === 'string' ? summary : undefined,
          pubDate: typeof updated === 'string' ? updated : undefined,
          guid: typeof id === 'string' ? id : undefined,
        };
      });
    }

    return [];
  } catch (err) {
    logger.debug({ err }, 'RSS: XML parse failed');
    return [];
  }
}

function itemFingerprint(feedUrl: string, item: RssItem): string {
  const key = `${feedUrl}:${item.guid ?? item.link ?? item.title}`;
  return createHash('md5').update(key).digest('hex');
}

/** 清理 HTML 标签，截断描述 */
function cleanDescription(desc?: string): string {
  if (!desc) return '';
  return desc
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 用 bot 风格评论一条资讯 */
async function commentOnItem(
  item: RssItem,
  sourceName?: string,
): Promise<string | null> {
  try {
    const result = await callWithFallback({
      usage: env().RSS_USAGE,
      messages: [
        {
          role: 'system',
          content: `你是${env().BOT_USERNAME}，一个住在群里的猫娘群友。你看到了一条资讯，想随口分享给群里。用你自己的风格——像群友转发时附带的一句吐槽或感叹，不要像新闻播报。一句话，50字以内。只输出要发的那句话。`,
        },
        {
          role: 'user',
          content: `标题: ${item.title}\n摘要: ${cleanDescription(item.description)}${sourceName ? `\n来源: ${sourceName}` : ''}\n\n你随口说一句:`,
        },
      ],
      maxTokens: 80,
      temperature: 1.0,
    });
    const text = result.content.trim().replace(/^["「『]|["」』]$/g, '');
    return text.length >= 2 ? text : null;
  } catch (err) {
    logger.debug({ err }, 'RSS: comment generation failed');
    return null;
  }
}

export async function runRssMonitor(): Promise<void> {
  const e = env();
  if (!e.RSS_MONITOR_ENABLED) return;

  const feeds = parseFeedsConfig(e.RSS_FEEDS_JSON);
  if (feeds.length === 0) {
    logger.debug('RSS monitor: no feeds configured');
    return;
  }

  const redis = getRedis();
  const sender = new StreamingSender();
  let totalNew = 0;

  for (const feed of feeds) {
    try {
      // Fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'nyat-bot-rss/1.0' },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn({ url: feed.url, status: res.status }, 'RSS: fetch failed');
        continue;
      }

      const xml = await res.text();
      const items = extractItems(xml);
      if (items.length === 0) {
        logger.debug({ url: feed.url }, 'RSS: no items parsed');
        continue;
      }

      const seenKey = SEEN_PREFIX + feed.chatId;
      const fuelKey = FUEL_PREFIX + feed.chatId;
      const newItems: RssItem[] = [];

      // Check which items are new (reverse order — oldest first)
      for (const item of [...items].reverse()) {
        const fp = itemFingerprint(feed.url, item);
        const isNew = await redis.sadd(seenKey, fp);
        if (isNew === 1) {
          // First time seeing this item
          await redis.expire(seenKey, SEEN_TTL_SEC);
          newItems.push(item);

          // Store as fuel for proactive messaging
          const fuelEntry = JSON.stringify({
            title: item.title,
            link: item.link,
            source: feed.sourceName,
          });
          await redis.lpush(fuelKey, fuelEntry);
          await redis.ltrim(fuelKey, 0, FUEL_MAX_LEN - 1);
          await redis.expire(fuelKey, 6 * 3600); // 6h

          totalNew++;
        }
      }

      if (newItems.length === 0) {
        logger.debug({ url: feed.url }, 'RSS: no new items');
        continue;
      }

      logger.info(
        { url: feed.url, chatId: feed.chatId, newCount: newItems.length },
        'RSS: new items found',
      );

      // Auto-post: send to chat with bot commentary
      if (feed.autoPost) {
        // Only auto-post the most recent 1-2 items to avoid spam
        const toPost = newItems.slice(-2);
        for (const item of toPost) {
          const comment = await commentOnItem(item, feed.sourceName);
          if (!comment) continue;

          const linkPart = item.link ? `\n${item.link}` : '';
          const message = `${comment}${linkPart}`;

          try {
            await sender.sendDirect(feed.chatId, message);
            logger.info(
              { chatId: feed.chatId, title: item.title.slice(0, 60) },
              'RSS: auto-posted to chat',
            );
          } catch (err) {
            logger.warn({ err, chatId: feed.chatId }, 'RSS: auto-post send failed');
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.warn({ url: feed.url }, 'RSS: fetch timeout');
      } else {
        logger.warn({ err, url: feed.url }, 'RSS: feed processing failed');
      }
    }
  }

  if (totalNew > 0) {
    logger.info({ totalNew, feedCount: feeds.length }, 'RSS monitor: tick complete');
  }
}
