import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { accountKey } from '../platform/identity.js';
import { findConversationRef, findMessageRef, findUserRef, isPlatformInternalId } from '../platform/identity-store.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';
import type { AttentionItem, DispatchTask, SubagentCallback } from './types.js';

export type MetaScopeResult<T> = { status: 'valid'; value: T }
  | { status: 'invalid' | 'unavailable'; reason: string };
const invalid = (reason: string): MetaScopeResult<never> => ({ status: 'invalid', reason });
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Native Telegram IDs stay native; QQ IDs must resolve in the configured account. */
export function inspectMetaChatScope(chatId: unknown): MetaScopeResult<number> {
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0) return invalid('invalid_chat');
  if (!isPlatformInternalId(chatId)) return { status: 'valid', value: chatId };
  try {
    const ref = findConversationRef(chatId);
    if (!ref || ref.platform !== 'qq') return invalid('unresolved_qq_chat');
    if (!env().ONEBOT_ACCOUNT_ID || ref.accountId !== env().ONEBOT_ACCOUNT_ID) return invalid('wrong_qq_account');
    return { status: 'valid', value: chatId };
  } catch { return { status: 'unavailable', reason: 'identity_store_unavailable' }; }
}

function messageInChat(chatId: number, messageId: unknown): boolean {
  if (!positiveId(messageId)) return false;
  return isPlatformInternalId(chatId) ? !!findMessageRef(chatId, messageId) : !isPlatformInternalId(messageId);
}

function userInChatAccount(chatId: number, userId: unknown, requirePrivatePeer = false): boolean {
  if (!positiveId(userId)) return false;
  if (!isPlatformInternalId(chatId)) return !isPlatformInternalId(userId) && (!requirePrivatePeer || chatId < 0 || chatId === userId);
  const chat = findConversationRef(chatId), user = findUserRef(userId);
  return !!chat && !!user && accountKey(chat) === accountKey(user)
    && (!requirePrivatePeer || chat.conversationKind !== 'private' || chat.id === user.id);
}

/** Sanitize quote copies separately: a bad quote must not erase a valid new message. */
export function inspectMetaAttention(input: AttentionItem): MetaScopeResult<AttentionItem> {
  if (!input || typeof input !== 'object') return invalid('invalid_attention');
  const scope = inspectMetaChatScope(input.chatId);
  if (scope.status !== 'valid') return scope;
  if (typeof input.id !== 'string' || !input.id || !['L0', 'L1', 'L1_CALLBACK', 'L2'].includes(input.layer)
    || typeof input.reason !== 'string' || !Number.isFinite(input.pressure)
    || !positiveId(input.createdAt) || (input.textPreview !== undefined && typeof input.textPreview !== 'string')) {
    return invalid('invalid_attention_shape');
  }
  try {
    if (input.messageId !== undefined && !messageInChat(input.chatId, input.messageId)) return invalid('message_scope_mismatch');
    if (input.userId !== undefined && !userInChatAccount(input.chatId, input.userId, true)) return invalid('user_scope_mismatch');
    if (input.messageThreadId !== undefined && (!positiveId(input.messageThreadId)
      || isPlatformInternalId(input.chatId) || isPlatformInternalId(input.messageThreadId))) return invalid('thread_scope_mismatch');
    if (input.messageId && isOneBotMessageRecalled(input.chatId, input.messageId)) return invalid('message_recalled');
    const payload = input.payload;
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) return invalid('invalid_payload');
    if (payload?.['sourceChatId'] !== undefined && payload['sourceChatId'] !== input.chatId) return invalid('payload_scope_mismatch');
    const quote = payload?.['replyTo'];
    if (quote !== undefined && quote !== null) {
      const q = typeof quote === 'object' && !Array.isArray(quote) ? quote as Record<string, unknown> : null;
      if (!q || !messageInChat(input.chatId, q['messageId'])
        || (q['sourceChatId'] !== undefined && q['sourceChatId'] !== input.chatId)
        || (q['uid'] !== undefined && !userInChatAccount(input.chatId, q['uid']))
        || isOneBotMessageRecalled(input.chatId, q['messageId'] as number)) {
        return { status: 'valid', value: { ...input, payload: { ...payload, replyTo: undefined } } };
      }
    }
    return { status: 'valid', value: input };
  } catch { return { status: 'unavailable', reason: 'identity_or_recall_store_unavailable' }; }
}

/** Also usable by durable task readers: a QQ task cannot inherit native TG references. */
export function inspectMetaTaskScope(task: DispatchTask): MetaScopeResult<DispatchTask> {
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id
    || !positiveId(task.createdAt) || typeof task.contentDirection !== 'string'
    || !['queued', 'running', 'waiting_user', 'done', 'failed'].includes(task.status)) return invalid('invalid_task');
  const scope = inspectMetaChatScope(task.chatId);
  if (scope.status !== 'valid') return scope;
  try {
    if (task.targetUserId !== undefined && !userInChatAccount(task.chatId, task.targetUserId, true)) return invalid('task_user_scope_mismatch');
    for (const ids of [task.quoteMessageIds, task.relatedQuoteIds]) {
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !messageInChat(task.chatId, id)))) return invalid('task_quote_scope_mismatch');
    }
    if (task.pendingUserInput !== undefined && (!Array.isArray(task.pendingUserInput)
      || task.pendingUserInput.some(input => !input || typeof input.text !== 'string'
        || (input.messageId !== undefined && !messageInChat(task.chatId, input.messageId))))) return invalid('task_pending_scope_mismatch');
    if (task.messageThreadId !== undefined && (!positiveId(task.messageThreadId)
      || isPlatformInternalId(task.chatId) || isPlatformInternalId(task.messageThreadId))) return invalid('task_thread_scope_mismatch');
    return { status: 'valid', value: task };
  } catch { return { status: 'unavailable', reason: 'identity_store_unavailable' }; }
}

/** A supplied chat label is not evidence that a task's result came from that chat. */
export async function inspectMetaTaskBinding(chatId: number, taskId: unknown): Promise<MetaScopeResult<DispatchTask>> {
  if (typeof taskId !== 'string' || !taskId) return invalid('missing_task_provenance');
  try {
    const { getGlobalState } = await import('./global-state.js');
    let task = getGlobalState().getTask?.(taskId);
    if (!task) {
      const { loadCodeActTask } = await import('../subagent/task-store.js');
      task = await loadCodeActTask(taskId, { throwOnError: true }) ?? undefined;
    }
    if (!task) return invalid('unknown_task_provenance');
    if (task.id !== taskId || task.chatId !== chatId) return invalid('task_chat_mismatch');
    const { checkCodeActActivation } = await import('../subagent/activation-policy.js');
    if (!checkCodeActActivation(task).allowed) return invalid('task_outside_activation');
    return inspectMetaTaskScope(task);
  } catch { return { status: 'unavailable', reason: 'task_store_unavailable' }; }
}

export async function inspectMetaCallback(input: SubagentCallback): Promise<MetaScopeResult<SubagentCallback>> {
  if (!input || typeof input.id !== 'string' || !input.id || typeof input.summary !== 'string'
    || typeof input.ok !== 'boolean' || !positiveId(input.createdAt)) return invalid('invalid_callback');
  const scope = inspectMetaChatScope(input.chatId);
  if (scope.status !== 'valid') return scope;
  const task = await inspectMetaTaskBinding(input.chatId, input.taskId);
  if (task.status !== 'valid') return task;
  return { status: 'valid', value: input };
}

/** Keep rejected original data for review; never log its text or silently relabel it. */
export async function holdMetaScopeInput(kind: 'attention' | 'callback', input: unknown, reason: string): Promise<boolean> {
  try {
    const raw = JSON.stringify(input);
    const id = `${kind}:${createHash('sha256').update(raw).digest('hex')}`;
    await getRedis().hsetnx('xxb:meta:scope-held', id, JSON.stringify({ kind, reason, heldAt: Date.now(), input }));
    logger.warn({ kind, reason }, 'Meta input held by source scope policy');
    return true;
  } catch {
    logger.warn({ kind, reason }, 'Meta scope archive unavailable; retaining input for retry');
    return false;
  }
}
