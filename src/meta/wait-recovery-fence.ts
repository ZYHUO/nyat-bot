import { resolveConversationScope } from '../shared/privacy-scope.js';
import { isWaitRecoveryCurrent } from '../pipeline/turn/wait-replay.js';
import type { AttentionItem, WaitRecoveryFence } from './types.js';

export type WaitRecoverySource = Pick<AttentionItem, 'chatId' | 'messageId' | 'messageThreadId' | 'waitRecovery'>;

/** Resolve only actual host-provided references. A guest cannot escape a WAIT
 * fence by changing topic, inventing a quote, or supplying its own token. */
export function selectWaitRecovery(sources: readonly WaitRecoverySource[] | undefined, chatId: number,
  threadId: number, quotes: readonly number[]): WaitRecoveryFence | undefined {
  const scoped = sources?.filter(source => source.chatId === chatId) ?? [];
  if (!scoped.some(source => source.waitRecovery)) return undefined;
  if (!quotes.length) throw new Error('wait_recovery_source_missing');
  let selected: WaitRecoveryFence | undefined;
  for (const quote of quotes) {
    const matches = scoped.filter(source => source.messageId === quote && (source.messageThreadId ?? 0) === threadId);
    if (!matches.length) throw new Error('wait_recovery_source_missing');
    for (const source of matches) {
      const fence = source.waitRecovery;
      if (!fence) continue;
      if (fence.chatId !== chatId || fence.threadId !== threadId
        || selected && (selected.generation !== fence.generation || selected.accountId !== fence.accountId || selected.platform !== fence.platform)) {
        throw new Error('wait_recovery_source_mismatch');
      }
      selected = { ...fence };
    }
  }
  return selected;
}

/** Always re-read Redis at the final boundary; a previous successful check is
 * not permission to send after another WAIT, stop, new input or account switch. */
export async function isTaskWaitRecoveryCurrent(task: { chatId: number; messageThreadId?: number; waitRecovery?: WaitRecoveryFence }): Promise<boolean> {
  const fence = task.waitRecovery;
  if (!fence) return true;
  try {
    const scope = resolveConversationScope(task.chatId);
    if (!scope || !scope.accountId || scope.platform !== fence.platform || scope.accountId !== fence.accountId
      || scope.conversationKind !== 'group' || fence.chatId !== task.chatId
      || fence.threadId !== (task.messageThreadId ?? 0) || !/^[A-Za-z0-9_-]{1,128}$/.test(fence.generation)) return false;
    return await isWaitRecoveryCurrent(task.chatId, { isWaitReplay: true, waitGeneration: fence.generation });
  } catch { return false; }
}

export async function requireTaskWaitRecovery(task: { chatId: number; messageThreadId?: number; waitRecovery?: WaitRecoveryFence }): Promise<void> {
  if (!await isTaskWaitRecoveryCurrent(task)) {
    throw Object.assign(new Error('wait_recovery_stale'), { code: 'wait_recovery_stale', delivery: 'not_sent' as const });
  }
}
