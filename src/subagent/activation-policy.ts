import { env } from '../env.js';
import type { DispatchTask } from '../meta/types.js';
import { inspectMetaTaskScope } from '../meta/input-scope.js';

interface ActivationConfig {
  META_SUBAGENT_ENABLED?: boolean;
  CODEACT_ISOLATION_ENABLED?: boolean;
  META_SUBAGENT_CHAT_IDS?: readonly number[];
  META_ACTIVATED_AT_SEC?: number;
}
export type CodeActActivationReason =
  | 'meta_disabled' | 'isolation_disabled' | 'invalid_chat' | 'chat_outside_scope'
  | 'invalid_activation_epoch' | 'invalid_created_at' | 'predates_activation'
  | 'task_scope_invalid' | 'task_scope_unavailable'
  | 'checkpoint_missing' | 'checkpoint_invalid' | 'checkpoint_unavailable';
export type CodeActActivationDecision =
  | { allowed: true }
  | { allowed: false; reason: CodeActActivationReason };

/** Shared by enqueue, durable worker, local/resume executor, and Meta session ingress. */
export function checkCodeActActivation(
  subject: { chatId: unknown; createdAt?: unknown },
  config: ActivationConfig = env(),
): CodeActActivationDecision {
  if (config.META_SUBAGENT_ENABLED !== true) return { allowed: false, reason: 'meta_disabled' };
  if (config.CODEACT_ISOLATION_ENABLED !== true) return { allowed: false, reason: 'isolation_disabled' };
  const { chatId, createdAt } = subject;
  if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId) || chatId === 0) return { allowed: false, reason: 'invalid_chat' };
  const scope = config.META_SUBAGENT_CHAT_IDS ?? [];
  if (scope.length > 0 && !scope.includes(chatId)) return { allowed: false, reason: 'chat_outside_scope' };
  const epoch = config.META_ACTIVATED_AT_SEC ?? 0;
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || !Number.isSafeInteger(epoch * 1000)) {
    return { allowed: false, reason: 'invalid_activation_epoch' };
  }
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
    return { allowed: false, reason: 'invalid_created_at' };
  }
  if (createdAt < epoch * 1000) return { allowed: false, reason: 'predates_activation' };
  return { allowed: true };
}

/** Preserve rejected work for operator review; never replay or expire this archive. */
export async function holdCodeActTask(task: DispatchTask, reason: CodeActActivationReason): Promise<void> {
  const { getRedis } = await import('../db/redis.js');
  await getRedis().hsetnx('xxb:codeact:activation-held', task.id, JSON.stringify({
    heldAt: Date.now(), reason, task,
  }));
  const { logger } = await import('../shared/logger.js');
  logger.warn({ taskId: task.id, chatId: task.chatId, reason }, 'CodeAct task held by activation policy');
}

export async function requireCodeActActivation(task: DispatchTask): Promise<void> {
  const decision = checkCodeActTaskActivation(task);
  if (decision.allowed) return;
  await holdCodeActTask(task, decision.reason);
  throw new Error(`codeact_activation_denied:${decision.reason}`);
}

/** Durable tasks carry message/user references as well as a numeric chat label. */
export function checkCodeActTaskActivation(task: DispatchTask): CodeActActivationDecision {
  const activation = checkCodeActActivation(task);
  if (!activation.allowed) return activation;
  const scope = inspectMetaTaskScope(task);
  if (scope.status === 'valid') return activation;
  return { allowed: false, reason: scope.status === 'unavailable' ? 'task_scope_unavailable' : 'task_scope_invalid' };
}
