// ────────────────────────────────────────
// 口头禅自动惩罚 cron —— 盯 bot 自己发言,复读超阈值的短语自动降权 + 动态拉黑
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getRecentChatReplies } from '../tracking/self-history.js';
import {
  detectEmergentTics,
  addDynamicTicBans,
  demoteExpressions,
} from '../learners/tic-detector.js';

const ACTIVE_GROUPS_MAX_AGE = 30 * 86400;

export async function runTicPenalty(): Promise<void> {
  if (!env().TIC_PENALTY_ENABLED) return;
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  let chatIds: number[];
  try {
    await redis.zremrangebyscore('xxb:active_groups', '-inf', now - ACTIVE_GROUPS_MAX_AGE).catch(() => {});
    const raw = await redis.zrange('xxb:active_groups', 0, -1);
    chatIds = raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
  } catch (err) {
    logger.warn({ err }, 'tic-penalty: discover active groups failed');
    return;
  }

  const opts = {
    minMessages: env().TIC_PENALTY_MIN_MESSAGES,
    minFraction: env().TIC_PENALTY_MIN_FRACTION,
  };
  const ttl = env().TIC_PENALTY_TTL_SEC;
  let punishedChats = 0;
  let totalTics = 0;

  for (const chatId of chatIds) {
    try {
      const replies = getRecentChatReplies(chatId, env().TIC_PENALTY_WINDOW, 24);
      if (replies.length < opts.minMessages) continue;
      const hits = detectEmergentTics(replies.map((r) => r.text), opts);
      if (hits.length === 0) continue;
      const phrases = hits.map((h) => h.phrase);
      await addDynamicTicBans(chatId, phrases, ttl);
      const demoted = demoteExpressions(chatId, phrases);
      punishedChats++;
      totalTics += hits.length;
      logger.info(
        {
          chatId,
          sampled: replies.length,
          tics: hits.map((h) => `${h.phrase}(${h.pos},${h.messages}/${replies.length})`),
          demoted,
        },
        'tic-penalty: punished emergent tics',
      );
    } catch (err) {
      logger.debug({ err, chatId }, 'tic-penalty: chat failed');
    }
  }
  if (totalTics > 0) logger.info({ punishedChats, totalTics, chats: chatIds.length }, 'tic-penalty tick');
}
