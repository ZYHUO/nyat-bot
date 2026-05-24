// ────────────────────────────────────────
// Channel sync cron — scrape public channels and store in ChromaDB
// ────────────────────────────────────────

import { scrapeNewPosts } from './channel-scraper.js';
import { memorizeMessage } from '../memory/chroma.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';

export async function runChannelSync(): Promise<void> {
  const usernames = env().CHANNEL_SOURCE_USERNAMES;
  if (usernames.length === 0) return;

  for (const username of usernames) {
    try {
      const posts = await scrapeNewPosts(username);
      for (const post of posts) {
        const fakeMsg: FormattedMessage = {
          role: 'user',
          uid: 0,
          username,
          fullName: `📡 ${username}`,
          timestamp: Math.floor(Date.now() / 1000),
          messageId: Number(post.id),
          textContent: post.text,
          isForwarded: false,
        };
        // Use negative hash as chatId so channel posts are searchable
        const channelChatId = -(Math.abs(hashCode(username)) || username.split('').reduce((a, c) => a + c.charCodeAt(0), 1));
        await memorizeMessage(channelChatId, fakeMsg);
      }
      if (posts.length > 0) {
        logger.info({ username, count: posts.length }, 'Channel sync complete');
      }
    } catch (err) {
      logger.warn({ err, username }, 'Channel sync failed');
    }
  }
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
