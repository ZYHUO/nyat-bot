import type { AccountRef, ConversationKind, ConversationRef, MessageRef, UserRef } from './types.js';
import { PlatformBoundaryError } from './types.js';

export function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlatformBoundaryError('invalid_id', `${field} must be a nonempty opaque string`);
  }
  // Preserve punctuation, case and leading zeroes: adapters own ID semantics.
  return value;
}

export function assertAccount(account: AccountRef): void {
  opaqueId(account.accountId, 'accountId');
  if (
    !((account.platform === 'telegram' && account.idNamespace === 'telegram') ||
      (account.platform === 'qq' && (account.idNamespace === 'qq-number' || account.idNamespace === 'qq-openid')))
  ) {
    throw new PlatformBoundaryError('invalid_namespace', 'Platform and ID namespace do not match');
  }
}

export function accountKey(account: AccountRef): string {
  assertAccount(account);
  return JSON.stringify([account.platform, account.accountId, account.idNamespace]);
}

export function conversationKey(ref: ConversationRef): string {
  assertAccount(ref);
  if (ref.conversationKind !== 'private' && ref.conversationKind !== 'group') {
    throw new PlatformBoundaryError('invalid_chat_kind', 'Conversation kind must be explicit');
  }
  opaqueId(ref.id, 'conversation.id');
  if (ref.threadId !== undefined) opaqueId(ref.threadId, 'threadId');
  return JSON.stringify([
    ref.platform, ref.accountId, ref.idNamespace, ref.conversationKind, ref.id, ref.threadId ?? null,
  ]);
}

export function userKey(ref: UserRef): string {
  assertAccount(ref);
  return JSON.stringify([ref.platform, ref.accountId, ref.idNamespace, opaqueId(ref.id, 'user.id')]);
}

export function messageKey(ref: MessageRef): string {
  return JSON.stringify([conversationKey(ref.conversation), opaqueId(ref.id, 'message.id')]);
}

/** Only this compatibility adapter interprets Telegram's legacy numeric chat ID. */
export function fromTelegramChatId(accountId: string, chatId: number, threadId?: number): ConversationRef {
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new PlatformBoundaryError('invalid_telegram_id', 'Telegram chat ID must be a nonzero safe integer');
  }
  if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
    throw new PlatformBoundaryError('invalid_telegram_topic', 'Telegram topic ID must be a positive safe integer');
  }
  const ref: ConversationRef = {
    platform: 'telegram', accountId: opaqueId(accountId, 'accountId'), idNamespace: 'telegram',
    conversationKind: chatId < 0 ? 'group' : 'private', id: String(chatId),
    ...(threadId !== undefined ? { threadId: String(threadId) } : {}),
  };
  return ref;
}

/** Reject QQ/OpenID refs; never pass their positive group IDs to the Telegram pipeline. */
export function toTelegramChatId(ref: ConversationRef): number {
  conversationKey(ref);
  if (ref.platform !== 'telegram' || ref.idNamespace !== 'telegram') {
    throw new PlatformBoundaryError('wrong_platform', 'Only Telegram references can enter the legacy Telegram pipeline');
  }
  const id = Number(ref.id);
  if (!Number.isSafeInteger(id) || id === 0 || String(id) !== ref.id ||
    (id < 0 ? 'group' : 'private') !== ref.conversationKind) {
    throw new PlatformBoundaryError('invalid_telegram_id', 'Reference does not preserve Telegram chat semantics');
  }
  return id;
}

/** Retains both legacy chat and thread IDs when passing through the compatibility boundary. */
export function toTelegramTarget(ref: ConversationRef): { chatId: number; messageThreadId?: number } {
  const chatId = toTelegramChatId(ref);
  if (ref.threadId === undefined) return { chatId };
  const threadId = Number(ref.threadId);
  if (!Number.isSafeInteger(threadId) || threadId <= 0 || String(threadId) !== ref.threadId) {
    throw new PlatformBoundaryError('invalid_telegram_topic', 'Telegram topic ID must be a positive safe integer');
  }
  return { chatId, messageThreadId: threadId };
}

/** Official-platform OpenIDs stay opaque; this does not bind them to QQ numbers. */
export function qqOfficialConversation(accountId: string, kind: ConversationKind, openId: string): ConversationRef {
  const ref: ConversationRef = {
    platform: 'qq', accountId: opaqueId(accountId, 'accountId'), idNamespace: 'qq-openid',
    conversationKind: kind, id: opaqueId(openId, 'openid'),
  };
  conversationKey(ref);
  return ref;
}

export function qqOfficialUser(accountId: string, openId: string): UserRef {
  return {
    platform: 'qq', accountId: opaqueId(accountId, 'accountId'), idNamespace: 'qq-openid',
    id: opaqueId(openId, 'openid'),
  };
}
