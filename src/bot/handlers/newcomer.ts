import type { Bot, Context } from 'grammy';
import { logger } from '../../shared/logger.js';

/**
 * 新人进群感知（真人环境）：不秒欢迎（机器人感），记一笔到 missed 队列——
 * tick 决策时看到「xx 刚进群」，由 bot 自己挑自然时机欢迎一句。
 * bot 自己被拉进群走 my_chat_member（member.ts），不在此列。
 */
export function registerNewcomerHandler(bot: Bot): void {
  bot.on('message:new_chat_members', async (ctx: Context) => {
    try {
      const chat = ctx.chat;
      if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
      const members = ctx.message?.new_chat_members;
      if (!members?.length) return;

      const { noteMissed } = await import('../../meta/missed.js');
      for (const m of members) {
        if (m.is_bot) continue;
        const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.username || `uid:${m.id}`;
        await noteMissed(chat.id, {
          messageId: 0,
          uid: m.id,
          name: name.slice(0, 40),
          text: '',
          kind: 'join',
        });
        logger.info({ chatId: chat.id, uid: m.id, name }, 'newcomer noted');
      }
    } catch (err) {
      logger.debug({ err }, 'newcomer handler failed');
    }
  });
}
