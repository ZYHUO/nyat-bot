import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSS 新鲜度闸（2026-08-24）：pubDate 超过阈值的条目仍计 seen（防回潮）但不入谈资；
// 无日期/解析不了的放行。autoPost 关，不触达 sender/LLM。

const FEED_URL = 'https://example.com/feed.xml';
const CHAT_ID = -1001234567890;

const envBase: Record<string, unknown> = {
  RSS_MONITOR_ENABLED: true,
  RSS_FEEDS_JSON: JSON.stringify([{ url: FEED_URL, chatId: CHAT_ID, autoPost: false, sourceName: '测试源' }]),
  RSS_MAX_ITEM_AGE_HOURS: 72,
  RSS_USAGE: 'summarize',
  BOT_USERNAME: '啾咪囝',
};
vi.mock('../../../src/env.js', () => ({ env: () => envBase }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/bot/sender/streaming.js', () => ({
  StreamingSender: class {},
}));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(async () => ({ content: '喵' })),
}));

// In-memory Redis：sadd 记 seen，lpush/ltrim 记谈资
const seenStore = new Set<string>();
const fuelStore: string[] = [];
const redisMock = {
  sadd: vi.fn(async (_key: string, fp: string) => (seenStore.has(fp) ? 0 : (seenStore.add(fp), 1))),
  expire: vi.fn(async () => 1),
  lpush: vi.fn(async (_key: string, val: string) => (fuelStore.unshift(val), 1)),
  ltrim: vi.fn(async () => 'OK'),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

function feedXml(): string {
  const now = new Date().toUTCString();
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toUTCString();
  return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title>
<item><title>fresh news</title><link>http://x/1</link><pubDate>${now}</pubDate></item>
<item><title>stale old news</title><link>http://x/2</link><pubDate>${tenDaysAgo}</pubDate></item>
<item><title>no date news</title><link>http://x/3</link></item>
</channel></rss>`;
}

describe('rss-monitor 新鲜度闸', () => {
  beforeEach(() => {
    seenStore.clear();
    fuelStore.length = 0;
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => feedXml() })));
  });

  it('陈旧条目计 seen 但不入谈资；新鲜/无日期放行', async () => {
    const { runRssMonitor } = await import('../../../src/cron/rss-monitor.js');
    await runRssMonitor();

    const fuelTitles = fuelStore.map((f) => JSON.parse(f).title as string);
    expect(fuelTitles).toContain('fresh news');
    expect(fuelTitles).toContain('no date news');
    expect(fuelTitles).not.toContain('stale old news');

    // 三条都计了 seen（陈旧的也不会下轮回潮）
    expect(redisMock.sadd).toHaveBeenCalledTimes(3);
    expect(seenStore.size).toBe(3);
  });

  it('全都见过 → 不再入谈资', async () => {
    const { runRssMonitor } = await import('../../../src/cron/rss-monitor.js');
    await runRssMonitor();
    fuelStore.length = 0;
    await runRssMonitor();
    expect(fuelStore).toHaveLength(0);
  });
});
