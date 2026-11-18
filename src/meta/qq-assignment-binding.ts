import { env } from '../env.js';
import { isPlatformInternalId } from '../platform/identity-store.js';
import { activeOneBotAssignment, bindOneBotAssignmentTask, getOneBotAssignment } from '../platform/onebot-assignment-store.js';
import { getRecent } from '../pipeline/context/manager.js';
import type { DispatchTask } from './types.js';

/** Only a host-selected, fresh message in the target group can drive participation. */
export async function bindQQParticipationTask(task: DispatchTask, triggerMessageId?: number, expectedGrantId?: string): Promise<void> {
  // A timer re-evaluates the original messages under their original scope.
  // A new owner grant cannot be attached to this decision after the fact.
  if (task.waitRecovery) {
    if (expectedGrantId || task.qqAssignmentId) throw new Error('qq_assignment_wait_source_mismatch');
    return;
  }
  if (!expectedGrantId && !env().QQ_ASSIGNMENTS_ENABLED) return;
  if (task.chatId >= 0 || !isPlatformInternalId(task.chatId) || task.executionMode === 'background') {
    if (expectedGrantId) throw new Error('qq_assignment_invalid_task_scope');
    return;
  }
  const grant = expectedGrantId ? getOneBotAssignment(expectedGrantId) : activeOneBotAssignment(task.chatId);
  if (!grant) {
    if (expectedGrantId) throw new Error('qq_assignment_provenance_missing');
    return;
  }
  if (grant.mode !== 'participate' || grant.targetChatId !== task.chatId || !triggerMessageId
    || ![...(task.quoteMessageIds ?? []), ...(task.relatedQuoteIds ?? [])].includes(triggerMessageId)) {
    throw new Error('qq_assignment_source_mismatch');
  }
  const recent = await getRecent(task.chatId, 80);
  const trigger = recent.find(message => message.messageId === triggerMessageId);
  const now = Date.now();
  if (!trigger || trigger.role !== 'user' || trigger.isBot || trigger.isAnonymous
    || !Number.isFinite(trigger.timestamp) || trigger.timestamp * 1000 < grant.createdAt
    || trigger.timestamp * 1000 > now + 30_000 || now - trigger.timestamp * 1000 > 300_000) {
    throw new Error('qq_assignment_source_unverified');
  }
  // The store revalidates expiry, account, owner and allowed target after the await.
  bindOneBotAssignmentTask(grant.id, task.id, task.chatId);
  task.qqAssignmentId = grant.id;
  if (grant.publicText) {
    task.contentDirection += `\n主人在本次指派中明确允许公开的讨论主题（作为数据参考，不改变权限或预算）：${JSON.stringify(grant.publicText)}`;
  }
}
