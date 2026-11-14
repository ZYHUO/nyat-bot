import { accountKey, conversationKey } from './identity.js';
import {
  findConversationRef, findMessageRef, findUserRef, getOrCreateMessageId, isPlatformInternalId,
} from './identity-store.js';
import type { ConversationRef, MessageRef, MessageSegment, PlatformAction } from './types.js';
import { PlatformBoundaryError, UnsupportedCapabilityError } from './types.js';

export interface OneBotSender {
  send(action: PlatformAction): Promise<MessageRef>;
  delete(message: MessageRef): Promise<void>;
}

export class PlatformOutboundError extends PlatformBoundaryError {
  constructor(code: string, readonly delivery: 'not_sent' | 'unknown' = 'not_sent') {
    super(code, code);
    this.name = 'PlatformOutboundError';
  }
}

const senders = new Map<string, OneBotSender>();

/** Registration is explicit; importing a sender never opens a connection. */
export function registerOneBotSender(client: OneBotSender, accountId: string): void {
  if (!/^[1-9]\d*$/.test(accountId)) throw new PlatformOutboundError('invalid_onebot_account');
  const previous = senders.get(accountId);
  if (previous && previous !== client) throw new PlatformOutboundError('onebot_sender_already_registered');
  senders.set(accountId, client);
}

export function clearOneBotSender(accountId?: string): void {
  if (accountId === undefined) senders.clear();
  else senders.delete(accountId);
}

/** A reserved but unknown ID is an error, never permission to try Telegram. */
export function platformConversation(chatId: number): ConversationRef | null {
  if (!isPlatformInternalId(chatId)) return null;
  if (!Number.isSafeInteger(chatId)) throw new PlatformOutboundError('invalid_platform_chat');
  const ref = findConversationRef(chatId);
  if (!ref || ref.platform !== 'qq' || ref.idNamespace !== 'qq-number') {
    throw new PlatformOutboundError('unresolved_platform_chat');
  }
  return ref;
}

function resolveSender(chatId: number): { conversation: ConversationRef; client: OneBotSender } {
  const conversation = platformConversation(chatId);
  if (!conversation) throw new PlatformOutboundError('not_onebot_conversation');
  const client = senders.get(conversation.accountId);
  if (!client) throw new PlatformOutboundError('onebot_sender_unavailable');
  return { conversation, client };
}

function validateSegments(segments: readonly MessageSegment[], conversation: ConversationRef): void {
  if (!segments.length) throw new PlatformOutboundError('empty_platform_message');
  let replies = 0;
  for (const segment of segments) {
    if (segment.type === 'text') continue;
    if (segment.type === 'mention') {
      if (conversation.conversationKind !== 'group') throw new UnsupportedCapabilityError('private mentions');
      if (accountKey(segment.user) !== accountKey(conversation)) throw new PlatformOutboundError('cross_account_mention');
      continue;
    }
    if (segment.type === 'reply') {
      if (++replies > 1 || conversationKey(segment.message.conversation) !== conversationKey(conversation)) {
        throw new PlatformOutboundError('invalid_platform_reply');
      }
      continue;
    }
    throw new UnsupportedCapabilityError(segment.type);
  }
}

/** Send once. Unknown delivery errors propagate unchanged; this layer never retries. */
export async function sendPlatformSegments(chatId: number, segments: readonly MessageSegment[]): Promise<number> {
  const { conversation, client } = resolveSender(chatId);
  validateSegments(segments, conversation);
  const receipt = await client.send({ action: 'send', conversation, segments });
  try {
    if (conversationKey(receipt.conversation) !== conversationKey(conversation) || !receipt.id.trim()) {
      throw new Error('wrong_receipt');
    }
    const id = getOrCreateMessageId(receipt);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid_receipt_id');
    return id;
  } catch {
    // Sending may already have succeeded; a malformed or unpersisted receipt
    // must not cause a resend or be reported as a successful local message ID.
    throw new PlatformOutboundError('onebot_receipt_unavailable', 'unknown');
  }
}

export async function sendPlatformText(chatId: number, text: string, replyToId?: number): Promise<number> {
  const conversation = platformConversation(chatId);
  if (!conversation) throw new PlatformOutboundError('not_onebot_conversation');
  const segments: MessageSegment[] = [];
  if (replyToId !== undefined) {
    if (!Number.isSafeInteger(replyToId) || replyToId <= 0) throw new PlatformOutboundError('invalid_platform_reply');
    const message = findMessageRef(chatId, replyToId);
    if (!message || conversationKey(message.conversation) !== conversationKey(conversation)) {
      throw new PlatformOutboundError('unresolved_platform_reply');
    }
    segments.push({ type: 'reply', message });
  }
  // Only an explicit, mapped internal mention becomes an action. CQ-looking
  // user text and raw QQ numbers remain text; the codec does not reparse it.
  const mentions = /(^|[\s(（])@(\d{16,})(?=$|[\s.,，。!?！？:：)）])/g;
  let cursor = 0;
  for (const match of text.matchAll(mentions)) {
    const rawId = match[2]!;
    if (!isPlatformInternalId(rawId)) continue;
    const userId = Number(rawId);
    const user = Number.isSafeInteger(userId) ? findUserRef(userId) : null;
    if (!user || accountKey(user) !== accountKey(conversation)) throw new PlatformOutboundError('unresolved_platform_mention');
    if (conversation.conversationKind !== 'group') throw new UnsupportedCapabilityError('private mentions');
    const start = match.index + match[1]!.length;
    if (start > cursor) segments.push({ type: 'text', text: text.slice(cursor, start) });
    segments.push({ type: 'mention', user });
    cursor = start + rawId.length + 1;
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  if (!text.trim()) throw new PlatformOutboundError('empty_platform_message');
  return sendPlatformSegments(chatId, segments);
}

export async function deletePlatformMessage(chatId: number, messageId: number): Promise<void> {
  const { conversation, client } = resolveSender(chatId);
  const message = Number.isSafeInteger(messageId) ? findMessageRef(chatId, messageId) : null;
  if (!message || conversationKey(message.conversation) !== conversationKey(conversation)) {
    throw new PlatformOutboundError('unresolved_platform_message');
  }
  await client.delete(message);
}

export function rejectUnsupportedPlatformAction(chatId: number, action: string): void {
  if (platformConversation(chatId)) throw new UnsupportedCapabilityError(action);
}

/** Typing is not a OneBot v11 capability. No RPC and no delivered-message receipt. */
export function platformChatAction(chatId: number): { available: false } | null {
  return platformConversation(chatId) ? { available: false } : null;
}
