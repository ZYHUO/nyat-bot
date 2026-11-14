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
import { registerOneBotMedia } from './onebot-media.js';
import { assertOneBotMediaUrl } from './onebot-media-policy.js';
import { getPlatformBotIdentity } from './account-context.js';

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
  const media: Partial<Pick<Message, 'photo' | 'voice' | 'video' | 'document'>> = {};
  for (const segment of message.segments) {
    switch (segment.type) {
      case 'text': text += segment.text; break;
      case 'mention': {
        if (accountKey(segment.user) !== accountKey(conversation)) throw new PlatformBoundaryError('wrong_account', 'Mention crosses accounts');
        const id = getOrCreateUserId(segment.user);
        const self = segment.user.id === conversation.accountId;
        const name = self ? getPlatformBotIdentity(chatId, env().BOT_NICKNAMES ?? [], env().ONEBOT_DISPLAY_NAME)?.displayName : undefined;
        const label = `@${name ?? id}`;
        entities.push({ type: 'text_mention', offset: text.length, length: label.length, user: {
          id, is_bot: self, first_name: name ?? segment.user.id,
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
      case 'image': case 'voice': case 'video': case 'file': {
        if (!/^qq-media:[0-9a-f-]{36}$/.test(segment.assetRef)) {
          text += `[QQ ${segment.type}：媒体内容不可读取]`;
          break;
        }
        const file = { file_id: segment.assetRef, file_unique_id: segment.assetRef,
          ...(segment.fileSize === undefined ? {} : { file_size: segment.fileSize }) };
        if (segment.type === 'image') media.photo ??= [{ ...file, width: 1, height: 1 }];
        if (segment.type === 'voice') media.voice ??= { ...file, duration: 0, mime_type: 'audio/mpeg' };
        if (segment.type === 'video') media.video ??= { ...file, width: 1, height: 1, duration: 0 };
        if (segment.type === 'file') media.document ??= { ...file, file_name: segment.fileName ?? 'attachment.bin', mime_type: segment.mimeType };
        text += `[QQ 附件 ${segment.type}${segment.fileName ? ' ' + segment.fileName : ''}；引用 ${segment.assetRef}]`;
        break;
      }
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
    text, entities, ...media, ...(reply ? { reply_to_message: reply } : {}),
  } };
}

export async function ingestOneBotMessage(message: NormalizedMessage, context: { signal: AbortSignal },
  handleCommand?: (message: NormalizedMessage, context: { signal: AbortSignal }) => Promise<boolean>): Promise<void> {
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
  if (context.signal.aborted) return;
  const key = 'xxb:onebot:received:' + createHash('sha256').update(messageKey(message.ref)).digest('hex');
  // Fail closed on Redis failure. Claim before dispatch: no automatic replay of
  // an event whose handler may already have performed external side effects.
  if (await getRedis().set(key, '1', 'EX', 86400, 'NX') !== 'OK') return;
  if (context.signal.aborted) return;
  if (handleCommand && await handleCommand(message, context)) return;
  const segments = [];
  for (const segment of message.segments) {
    if (context.signal.aborted) return;
    if (config.ONEBOT_MEDIA_ENABLED && (segment.type === 'image' || segment.type === 'voice' || segment.type === 'video' || segment.type === 'file')) {
      try {
        let url: string | undefined;
        const candidate = segment.url ?? (/^https?:\/\//i.test(segment.assetRef) ? segment.assetRef : undefined);
        if (candidate) {
          try { url = assertOneBotMediaUrl(candidate).href; } catch { /* A valid asset can still use the authenticated stream. */ }
        }
        const handle = await registerOneBotMedia({ message: message.ref, kind: segment.type,
          assetId: /^https?:\/\//i.test(segment.assetRef) ? undefined : segment.assetRef,
          url, fileName: segment.fileName, fileSize: segment.fileSize, mimeType: segment.mimeType });
        segments.push({ ...segment, assetRef: handle, url: undefined });
      } catch { segments.push({ type: 'unsupported' as const, platformType: `${segment.type}（媒体不可用）` }); }
    } else segments.push(segment);
  }
  const update = oneBotToCoreUpdate({ ...message, segments }, recent);
  await ingestChatUpdate(update);
}
