// ────────────────────────────────────────
// Bot Command Learn cron — 周期观察学其他 bot 的命令档案(P1,纯观察)
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { learnChatBotCommands } from '../learners/bot-command-learner.js';
import { getBotUid } from '../bot/bot.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

const ACTIVE_GROUPS_MAX_AGE = 30 * 86400;

export async function runBotCommandLearn(): Promise<void> {
  if (!env().BOT_COMMAND_LEARN_ENABLED) return;
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  let chatIds: number[];
  try {
    await redis.zremrangebyscore('xxb:active_groups', '-inf', now - ACTIVE_GROUPS_MAX_AGE).catch(() => {});
    const raw = await redis.zrange('xxb:active_groups', 0, -1);
    chatIds = raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
  } catch (err) {
    logger.warn({ err }, 'bot-command-scan: discover failed');
    return;
  }
  const botUid = getBotUid();
  let total = 0;
  for (const chatId of chatIds) {
    try {
      total += await learnChatBotCommands(chatId, botUid);
    } catch (err) {
      logger.debug({ err, chatId }, 'bot-command-scan: chat failed');
    }
  }
  if (total > 0) logger.info({ total, chats: chatIds.length }, 'bot-command-scan tick');
}
