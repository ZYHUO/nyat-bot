import { env } from '../env.js';
import { findConversationRef, isPlatformInternalId } from '../platform/identity-store.js';
import type { ConversationKind, Platform } from '../platform/types.js';

export interface ConversationScope {
  chatId: number;
  platform: Platform;
  /** Unknown Telegram account permits local legacy reads only, never sharing. */
  accountId: string | null;
  conversationKind: ConversationKind;
}

export interface ConversationSource {
  visibility?: 'private' | 'contextual' | 'public';
  sourcePlatform?: Platform;
  sourceAccountId?: string;
}

/** Resolve stored identity, not a platform guessed from a model-supplied label. */
export function resolveConversationScope(chatId: number): ConversationScope | null {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  if (isPlatformInternalId(chatId)) {
    try {
      const ref = findConversationRef(chatId);
      if (!ref || ref.platform !== 'qq' || ref.idNamespace !== 'qq-number'
        || !/^[1-9]\d*$/.test(ref.accountId)
        || (ref.conversationKind === 'private') !== (chatId > 0)) return null;
      return { chatId, platform: ref.platform, accountId: ref.accountId, conversationKind: ref.conversationKind };
    } catch { return null; }
  }
  // Native Telegram IDs are the existing single-account conversation buckets.
  // Extract only the public bot ID; the credential never enters metadata/logs.
  let token: unknown;
  try { token = env().BOT_TOKEN; } catch { token = undefined; }
  const accountId = typeof token === 'string' ? /^([1-9]\d*):/.exec(token)?.[1] ?? null : null;
  return { chatId, platform: 'telegram', accountId, conversationKind: chatId > 0 ? 'private' : 'group' };
}

export function isValidConversationScope(chatId: number): boolean {
  return resolveConversationScope(chatId) !== null;
}

export function samePlatformAccount(left: number, right: number): boolean {
  const a = resolveConversationScope(left), b = resolveConversationScope(right);
  return !!a && !!b && a.platform === b.platform && a.accountId !== null && a.accountId === b.accountId;
}

/** Unconditional privacy boundary. Feature flags do not grant disclosure rights. */
export function canReadConversationSource(
  sourceChatId: number,
  boundChatId: number,
  provenance: ConversationSource = {},
): boolean {
  const source = resolveConversationScope(sourceChatId), target = resolveConversationScope(boundChatId);
  if (!source || !target) return false;
  // A present but inconsistent field must never be treated like absent legacy data.
  if (provenance.sourcePlatform !== undefined && provenance.sourcePlatform !== source.platform) return false;
  if (provenance.sourceAccountId !== undefined &&
    (!provenance.sourceAccountId || provenance.sourceAccountId !== source.accountId)) return false;
  if (sourceChatId === boundChatId) return true;
  if (provenance.visibility !== 'public' || source.conversationKind === 'private') return false;
  if ((env().MEMORY_SENSITIVE_CHAT_IDS ?? []).includes(sourceChatId)) return false;
  // Historical native IDs alone cannot prove which bot account wrote a record.
  // Explicit provenance is also required for QQ public exports, uniformly.
  return provenance.sourcePlatform === source.platform && !!provenance.sourceAccountId
    && source.accountId !== null && provenance.sourceAccountId === source.accountId
    && source.platform === target.platform && source.accountId === target.accountId;
}
