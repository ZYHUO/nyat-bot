import { resolveConversationScope } from '../shared/privacy-scope.js';
import type { ConversationScope } from '../shared/privacy-scope.js';

/** Persisted summaries are evidence for one account, conversation and topic only. */
export interface ContextScope extends ConversationScope {
  accountId: string;
  threadId: number;
}

export function resolveContextScope(chatId: number, threadId?: number): ContextScope | null {
  const source = resolveConversationScope(chatId);
  if (!source?.accountId || (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId < 0))) return null;
  return { ...source, accountId: source.accountId, threadId: threadId && threadId > 1 ? threadId : 0 };
}

export function matchesContextScope(stored: unknown, expected: ContextScope | null): boolean {
  if (!expected || !stored || typeof stored !== 'object') return false;
  const value = stored as Partial<ContextScope>;
  return value.chatId === expected.chatId && value.platform === expected.platform
    && value.accountId === expected.accountId && value.threadId === expected.threadId
    && value.conversationKind === expected.conversationKind;
}
