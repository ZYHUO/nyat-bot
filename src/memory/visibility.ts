import { env } from '../env.js';
import { canReadConversationSource, resolveConversationScope, type ConversationSource } from '../shared/privacy-scope.js';

export type ChatVisibility = 'private' | 'shared';
export type MemoryVisibility = 'private' | 'contextual' | 'public';

/** Private/unknown sources stay private, independently of legacy feature flags. */
export function getChatVisibility(chatId: number | null | undefined): ChatVisibility {
  const scope = typeof chatId === 'number' ? resolveConversationScope(chatId) : null;
  if (!scope || scope.conversationKind === 'private') return 'private';
  return (env().MEMORY_SENSITIVE_CHAT_IDS ?? []).includes(scope.chatId) ? 'private' : 'shared';
}

export function isPrivateChat(chatId: number | null | undefined): boolean {
  return getChatVisibility(chatId) === 'private';
}

export function defaultVisibilityForChat(chatId: number): MemoryVisibility {
  return isPrivateChat(chatId) ? 'private' : 'contextual';
}

export interface VisibilityFields extends ConversationSource {
  sourceChatId?: number | null;
}

/** Local proven history is usable; crossing contexts needs explicit public provenance. */
export function isCrossContextPrivate(item: VisibilityFields, boundChatId: number): boolean {
  return !item || typeof item.sourceChatId !== 'number'
    || !canReadConversationSource(item.sourceChatId, boundChatId, item);
}

export interface ScrubResult<T> { kept: T[]; dropped: number; }

export function scrubMemoryHits<T extends VisibilityFields>(hits: readonly T[], boundChatId: number): ScrubResult<T> {
  if (!Array.isArray(hits)) return { kept: [], dropped: 0 };
  const kept = hits.filter(hit => !isCrossContextPrivate(hit, boundChatId));
  return { kept, dropped: hits.length - kept.length };
}

export interface ProfileFragment extends VisibilityFields { text: string; }

export function scrubProfileFragments(fragments: readonly ProfileFragment[], boundChatId: number): ProfileFragment[] {
  return scrubMemoryHits(fragments, boundChatId).kept;
}
