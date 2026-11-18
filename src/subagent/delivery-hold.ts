import { getRedis } from '../db/redis.js';
import { isPlatformInternalId } from '../platform/identity-store.js';
import { isUnknownDelivery } from '../shared/delivery-result.js';
import { randomUUID } from 'node:crypto';
import { requireTaskWaitRecovery } from '../meta/wait-recovery-fence.js';
import type { WaitRecoveryFence } from '../meta/types.js';

export const DELIVERY_UNKNOWN_SUMMARY = 'failed_delivery_unknown_no_retry';
export const DELIVERY_HOLD_KEY = 'xxb:codeact:delivery-unknown';

class CodeActDeliveryError extends Error {
  constructor(readonly code: string, readonly delivery: 'not_sent' | 'unknown') {
    super(code);
    this.name = 'CodeActDeliveryError';
  }
}

const CLEAR_MATCHING_INTENT = `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call('HDEL', KEYS[1], ARGV[1])
end
return 0`;

/** Durable before-send claim. A crash or Redis outage after send leaves it held. */
export async function withCodeActDeliveryIntent<T>(
  taskId: string | undefined,
  chatId: number,
  operation: () => Promise<T>,
  wait?: { waitRecovery?: WaitRecoveryFence; messageThreadId?: number },
): Promise<T> {
  if (wait?.waitRecovery) await requireTaskWaitRecovery({ chatId, ...wait });
  if (!taskId) {
    if (isPlatformInternalId(chatId)) throw new CodeActDeliveryError('qq_delivery_task_required', 'not_sent');
    return operation(); // Legacy non-task callers have no replayable CodeAct identity.
  }
  const intent = JSON.stringify({ taskId, chatId, at: Date.now(), code: 'delivery_in_flight', attempt: randomUUID() });
  let claimed: number;
  try { claimed = await getRedis().hsetnx(DELIVERY_HOLD_KEY, taskId, intent); }
  catch { throw new CodeActDeliveryError('delivery_intent_store_unavailable', 'not_sent'); }
  if (claimed !== 1) throw new CodeActDeliveryError('delivery_already_held', 'unknown');

  const clear = async (): Promise<void> => {
    let removed: unknown;
    try { removed = await getRedis().eval(CLEAR_MATCHING_INTENT, 1, DELIVERY_HOLD_KEY, taskId, intent); }
    catch { throw new CodeActDeliveryError('delivery_confirmation_store_unavailable', 'unknown'); }
    if (removed !== 1) throw new CodeActDeliveryError('delivery_intent_changed', 'unknown');
  };

  let result: T;
  try {
    // The delivery hold itself awaits Redis. Recheck after that await, directly
    // before the logical operation; never cache a previous generation verdict.
    if (wait?.waitRecovery) await requireTaskWaitRecovery({ chatId, ...wait });
    result = await operation();
  }
  catch (error) {
    const delivery = error && typeof error === 'object' && 'delivery' in error ? error.delivery : undefined;
    if (delivery === 'not_sent' || delivery === 'rejected') {
      await clear();
      throw error;
    }
    // An error without a transport classification cannot prove no delivery.
    // Keep the durable claim and let the host stop without interpreting text.
    if (delivery === 'unknown') throw error;
    throw new CodeActDeliveryError('delivery_result_unclassified', 'unknown');
  }
  await clear();
  return result;
}

/** Only structured transport/intent errors at a send boundary close a task. */
export function isUnknownPlatformDelivery(chatId: number, error: unknown): boolean {
  return isUnknownDelivery(error) || (error !== null && typeof error === 'object'
    && 'delivery' in error && error.delivery === 'unknown'
    && (isPlatformInternalId(chatId) || error instanceof CodeActDeliveryError));
}

/** No TTL: an old BullMQ payload must not become sendable after its task hash expires. */
export async function holdUnknownCodeActDelivery(taskId: string, chatId: number, code: string): Promise<void> {
  const safeCode = /^[a-z0-9_:-]{1,64}$/i.test(code) ? code : 'delivery_unknown';
  await getRedis().hsetnx(DELIVERY_HOLD_KEY, taskId, JSON.stringify({ taskId, chatId, at: Date.now(), code: safeCode }));
}

/** Redis failure is deliberately not fail-open for a replayable task. */
export async function isCodeActDeliveryHeld(taskId: string): Promise<boolean> {
  return (await getRedis().hget(DELIVERY_HOLD_KEY, taskId)) !== null;
}
