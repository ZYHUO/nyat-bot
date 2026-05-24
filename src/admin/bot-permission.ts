import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';

export interface BotPermissionSnapshot {
  status: string;
  can_send_messages: boolean;
  can_delete_messages: boolean;
  can_pin_messages: boolean;
  can_manage_chat: boolean;
  can_invite_users: boolean;
  is_anonymous: boolean;
}

export async function getBotPermissions(
  bot: Bot,
  chatId: number,
): Promise<BotPermissionSnapshot | null> {
  try {
    const botInfo = await bot.api.getMe();
    const member = await bot.api.getChatMember(chatId, botInfo.id);

    const admin = member.status === 'administrator' ? member : null;
    const restricted = member.status === 'restricted' ? member : null;
    return {
      status: member.status,
      can_send_messages: restricted ? restricted.can_send_messages !== false : true,
      can_delete_messages: !!admin?.can_delete_messages,
      can_pin_messages: !!admin?.can_pin_messages,
      can_manage_chat: !!admin?.can_manage_chat,
      can_invite_users: !!admin?.can_invite_users,
      is_anonymous: !!admin?.is_anonymous,
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'getBotPermissions failed');
    return null;
  }
}
