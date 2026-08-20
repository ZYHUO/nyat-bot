import type { Bot, Context } from 'grammy';
import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../env.js';
import type { AllowlistConfig } from '../../allowlist/types.js';
import * as allowlist from '../../allowlist/allowlist.js';
import * as notify from '../../allowlist/notify.js';

export function registerMemberHandler(
  bot: Bot,
  config: AllowlistConfig,
): void {
  bot.on('my_chat_member', async (ctx: Context) => {
    const update = ctx.myChatMember;
    if (!update) return;

    const chatId = update.chat.id;
    const newStatus = update.new_chat_member.status;
    const chatType = update.chat.type;

    if (chatType !== 'group' && chatType !== 'supergroup') return;

    const redis = getRedis();

    if (newStatus === 'member' || newStatus === 'administrator') {
      logger.info({ chatId, status: newStatus }, 'Bot joined group');
      // 入群自动审核：bot 被拉进群就直接跑一遍 AI 审核，不等申请。
      if (env().ALLOWLIST_REVIEW_ON_JOIN && config.enabled) {
        try {
          const { callAllowlistReviewModel } = await import('../../allowlist/ai-call.js');
          const botFlow = await import('../../allowlist/bot-flow.js');
          const { getBotUid } = await import('../bot.js');
          const from = update.from;
          await botFlow.reviewOnJoin(
            {
              redis,
              bot,
              config,
              aiCall: callAllowlistReviewModel,
              getRecentContext: botFlow.defaultGetRecentContext,
              masterUid: env().MASTER_UID,
              botUid: getBotUid(),
            },
            chatId,
            {
              uid: from.id,
              username: from.username,
              firstName: from.first_name,
            },
          );
        } catch (err) {
          logger.warn({ err, chatId }, 'reviewOnJoin failed, falling back to static notice');
          await notify.onBotJoinedGroup(bot, redis, config, chatId);
        }
        return;
      }
      await notify.onBotJoinedGroup(bot, redis, config, chatId);
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      logger.info({ chatId, status: newStatus }, 'Bot removed from group');
      const removed = await allowlist.removeGroup(redis, config, chatId);
      if (removed) {
        logger.info({ chatId }, 'Group auto-removed from allowlist');
      }
    }
  });
}
