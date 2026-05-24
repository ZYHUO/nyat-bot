import type { Bot, Context } from 'grammy';
import { logger } from '../../shared/logger.js';
import { isDuplicate } from '../middleware/dedup.js';
import { isRateLimited } from '../middleware/rate-limit.js';
import { enqueue } from '../../queue/producer.js';

async function handleUpdate(ctx: Context): Promise<void> {
  const msg = ctx.message ?? ctx.editedMessage ?? ctx.channelPost ?? ctx.editedChannelPost;
  if (!msg) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const userId = msg.from?.id;
  const isEdit = !!(ctx.editedMessage ?? ctx.editedChannelPost);

  // Dedup (fail-open on Redis error to avoid silent message loss)
  try {
    if (await isDuplicate(chatId, messageId, isEdit)) return;
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'Dedup check failed, proceeding');
  }

  // Rate limit (fail-open on Redis error)
  try {
    if (userId && (await isRateLimited(userId))) return;
  } catch (err) {
    logger.warn({ err, userId }, 'Rate limit check failed, proceeding');
  }

  const senderChat = msg.sender_chat;
  const senderChatUsername = senderChat && 'username' in senderChat ? senderChat.username : undefined;
  const senderChatTitle = senderChat && 'title' in senderChat ? senderChat.title : undefined;
  const isAnonymousAdmin = msg.from?.id === 1087968824;
  const displayName = (isAnonymousAdmin || !msg.from)
    ? (senderChatTitle ?? senderChatUsername ?? 'channel')
    : (msg.from.username ?? msg.from.first_name ?? 'unknown');

  logger.debug(
    {
      chatId,
      messageId,
      from: displayName,
      text: (msg.text ?? msg.caption)?.slice(0, 80),
    },
    'Message received',
  );

  // Enqueue for processing
  await enqueue({
    type: 'message',
    chatId,
    messageId,
    isEdit,
    update: ctx.update,
    enqueuedAt: Date.now(),
  });
}

export function registerMessageHandler(bot: Bot): void {
  bot.on('message', handleUpdate);
  bot.on('edited_message', handleUpdate);
  bot.on('channel_post', handleUpdate);
  bot.on('edited_channel_post', handleUpdate);
}
