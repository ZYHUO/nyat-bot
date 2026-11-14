import type { Message, MessageEntity, Update } from 'grammy/types';
import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { ingestChatUpdate } from '../bot/handlers/message.js';
import { getRecent } from '../pipeline/context/manager.js';
import type { FormattedMessage } from '../shared/types.js';
import { accountKey, conversationKey, messageKey } from './identity.js';
import { getOrCreateConversationId, getOrCreateMessageId, getOrCreateUserId } from './identity-store.js';
import { PlatformBoundaryError } from './types.js';
import type { NormalizedMessage } from './types.js';

export function parseOneBotIds(text: string): Set<string> {
  const ids = text.split(',').map(id => id.trim()).filter(Boolean);
  if (ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new PlatformBoundaryError('invalid_allowlist', 'QQ allowlists require comma-separated numeric IDs');
  }
  return new Set(ids);
}

/** Compatibility shape for the shared cognition pipeline, not a Telegram network event. */
export function oneBotToCoreUpdate(message: NormalizedMessage, recent: readonly FormattedMessage[] = []): Update {
  const conversation = message.ref.conversation;
  if (conversation.platform !== 'qq' || conversation.idNamespace !== 'qq-number'
    || accountKey(conversation) !== accountKey(message.sender)) {
    throw new PlatformBoundaryError('wrong_account', 'Only same-account QQ messages enter this bridge');
  }
  if (conversation.conversationKind === 'private' && conversation.id !== message.sender.id) {
    throw new PlatformBoundaryError('wrong_private_peer', 'Private sender must match the conversation peer');
  }
  const chatId = getOrCreateConversationId(conversation);
  const uid = getOrCreateUserId(message.sender);
  const mid = getOrCreateMessageId(message.ref);
  const entities: MessageEntity[] = [];
  let text = '';
  let reply: Message['reply_to_message'];
  for (const segment of message.segments) {
    switch (segment.type) {
      case 'text': text += segment.text; break;
      case 'mention': {
        if (accountKey(segment.user) !== accountKey(conversation)) throw new PlatformBoundaryError('wrong_account', 'Mention crosses accounts');
        const id = getOrCreateUserId(segment.user);
        const label = `@${id}`;
        entities.push({ type: 'text_mention', offset: text.length, length: label.length, user: {
          id, is_bot: segment.user.id === conversation.accountId, first_name: segment.user.id,
        } });
        text += label;
        break;
      }
      case 'reply': {
        if (conversationKey(segment.message.conversation) !== conversationKey(conversation)) {
          throw new PlatformBoundaryError('cross_conversation_reply', 'Quote crosses conversations');
        }
        const replyId = getOrCreateMessageId(segment.message);
        const known = recent.find(item => item.messageId === replyId);
        reply = {
          reply_to_message: undefined,
          message_id: replyId, date: known?.timestamp ?? Math.floor(message.timestampMs / 1000),
          chat: conversation.conversationKind === 'private'
            ? { id: chatId, type: 'private', first_name: conversation.id }
            : { id: chatId, type: 'group', title: `QQ ${conversation.id}` },
          ...(known ? { from: { id: known.uid, is_bot: known.role === 'assistant' || !!known.isBot, first_name: known.fullName || known.username || 'QQ 用户' } } : {}),
          text: known?.textContent.slice(0, 400) ?? '[引用的 QQ 消息未在本地上下文中]',
        };
        break;
      }
      case 'mention-all': text += '[QQ 全体成员提及]'; break;
      case 'image': text += '[QQ 图片：当前适配器未提供可读取内容]'; break;
      case 'voice': text += '[QQ 语音：当前适配器未提供可读取内容]'; break;
      case 'file': text += '[QQ 文件：当前适配器未提供可读取内容]'; break;
      case 'unsupported': text += `[QQ 未解析消息段：${segment.platformType.slice(0, 40)}]`; break;
    }
  }
  if (!text.trim() && !reply) throw new PlatformBoundaryError('empty_message', 'QQ event has no usable content');
  if (text.length > 16000) throw new PlatformBoundaryError('message_too_large', 'QQ message exceeds the ingress limit');
  return { update_id: mid, message: {
    message_id: mid, date: Math.floor(message.timestampMs / 1000),
    chat: conversation.conversationKind === 'private'
      ? { id: chatId, type: 'private', first_name: message.senderName || conversation.id }
      : { id: chatId, type: 'group', title: `QQ ${conversation.id}` },
    from: { id: uid, is_bot: false, first_name: message.senderName || message.sender.id },
    text, entities, ...(reply ? { reply_to_message: reply } : {}),
  } };
}

export async function ingestOneBotMessage(message: NormalizedMessage, context: { signal: AbortSignal }): Promise<void> {
  const config = env();
  if (!config.ONEBOT_ENABLED || context.signal.aborted) return;
  const chat = message.ref.conversation;
  if (chat.accountId !== config.ONEBOT_ACCOUNT_ID || message.sender.id === config.ONEBOT_ACCOUNT_ID) return;
  const allowed = parseOneBotIds(chat.conversationKind === 'group' ? config.ONEBOT_ALLOWED_GROUP_IDS : config.ONEBOT_ALLOWED_USER_IDS);
  if (allowed.size > 0 && !allowed.has(chat.id)) return;
  // Reject pre-activation imports and invalid future timestamps, not ordinary
  // delayed messages delivered after a brief reconnect.
  if (message.timestampMs < config.META_ACTIVATED_AT_SEC * 1000 || message.timestampMs > Date.now() + 300000) return;
  const chatId = getOrCreateConversationId(chat);
  const recent = message.segments.some(part => part.type === 'reply') ? await getRecent(chatId, 100) : [];
  const update = oneBotToCoreUpdate(message, recent);
  if (context.signal.aborted) return;
  const key = 'xxb:onebot:received:' + createHash('sha256').update(messageKey(message.ref)).digest('hex');
  // Fail closed on Redis failure. Claim before dispatch: no automatic replay of
  // an event whose handler may already have performed external side effects.
  if (await getRedis().set(key, '1', 'EX', 86400, 'NX') !== 'OK') return;
  if (context.signal.aborted) return;
  await ingestChatUpdate(update);
}
