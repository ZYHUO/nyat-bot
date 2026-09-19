import type { Bot } from 'grammy';
import { logger } from '../shared/logger.js';

export interface BotPermissionSnapshot {
  status: string;
  can_send_messages: boolean;
  can_send_media: boolean;
  can_send_voice: boolean;
  can_send_polls: boolean;
  can_send_other_messages: boolean;
  can_delete_messages: boolean;
  can_pin_messages: boolean;
  can_manage_chat: boolean;
  can_manage_topics: boolean;
  can_restrict_members: boolean;
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

    const admin = member.status === 'administrator' || member.status === 'creator' ? member : null;
    const restricted = member.status === 'restricted' ? member : null;
    const creator = member.status === 'creator';
    const adminFields = admin as (Partial<{
      can_delete_messages: boolean;
      can_pin_messages: boolean;
      can_manage_chat: boolean;
      can_manage_topics: boolean;
      can_restrict_members: boolean;
      can_invite_users: boolean;
      is_anonymous: boolean;
    }> | null);
    const canSendMessages = restricted ? restricted.can_send_messages !== false : member.status !== 'left' && member.status !== 'kicked';
    const canSendMedia = restricted
      ? restricted.can_send_photos !== false
        || restricted.can_send_videos !== false
        || restricted.can_send_documents !== false
        || restricted.can_send_audios !== false
        || restricted.can_send_other_messages !== false
      : canSendMessages;
    return {
      status: member.status,
      can_send_messages: canSendMessages,
      can_send_media: canSendMedia,
      can_send_voice: restricted ? restricted.can_send_voice_notes !== false || restricted.can_send_audios !== false : canSendMessages,
      can_send_polls: restricted ? restricted.can_send_polls !== false : canSendMessages,
      can_send_other_messages: restricted ? restricted.can_send_other_messages !== false : canSendMessages,
      can_delete_messages: creator || !!adminFields?.can_delete_messages,
      can_pin_messages: creator || !!adminFields?.can_pin_messages,
      can_manage_chat: creator || !!adminFields?.can_manage_chat,
      can_manage_topics: creator || !!adminFields?.can_manage_topics,
      can_restrict_members: creator || !!adminFields?.can_restrict_members,
      can_invite_users: creator || !!adminFields?.can_invite_users,
      is_anonymous: !!adminFields?.is_anonymous,
    };
  } catch (err) {
    logger.warn({ err, chatId }, 'getBotPermissions failed');
    return null;
  }
}
