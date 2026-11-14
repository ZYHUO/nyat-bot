// Shared Heart pile-on guard.
// - Elevate (evaluateMetaHeart): busy | arm | recent reply
// - Dispatch (autoDispatch / taskToGroup): busy | recent reply
//   Arm is set on Heart allow so parallel Heart LLMs silence, but must NOT
//   block the first CodeAct that the arm was set for.

import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { findConversationRef, isPlatformInternalId } from '../platform/identity-store.js';

function armKey(chatId: number): string {
  return `xxb:meta:heart_arm:${chatId}`;
}

/** Zero keeps the existing policy; only a verified QQ group gets an override. */
function refractoryPolicy(chatId: number): { ms: number; qqOverride: boolean } {
  const e = env();
  if (e.META_QQ_HEART_REFRACTORY_MS > 0 && chatId < 0 && isPlatformInternalId(chatId)) {
    try {
      const ref = findConversationRef(chatId);
      if (ref?.platform === 'qq' && ref.conversationKind === 'group') {
        return { ms: e.META_QQ_HEART_REFRACTORY_MS, qqOverride: true };
      }
    } catch {
      // Missing identity storage must never relax the existing cooldown.
    }
  }
  return { ms: e.META_HEART_REFRACTORY_MS, qqOverride: false };
}

/**
 * Stamp as soon as Heart elevates (before CodeAct speaks). Parallel Heart LLMs
 * that finish a few seconds later see this and stay silent — coalesce alone is
 * too short vs ~10s Heart latency.
 * @returns false if another Heart already armed this chat (caller should silence).
 */
export async function armMetaHeartRefractory(chatId: number): Promise<boolean> {
  const { ms, qqOverride } = refractoryPolicy(chatId);
  if (ms <= 0 || chatId >= 0) return true;
  try {
    // Keep Telegram's historical padding. QQ's explicit shorter policy uses
    // its actual millisecond window; busy + the latest confirmed text still
    // protect an active task and the time after it speaks.
    const ok = qqOverride
      ? await getRedis().set(armKey(chatId), String(Date.now()), 'PX', Math.max(5000, ms), 'NX')
      : await getRedis().set(armKey(chatId), String(Date.now()), 'EX', Math.max(5, Math.ceil(ms / 1000) + 5), 'NX');
    return ok === 'OK';
  } catch (err) {
    logger.debug({ err, chatId }, 'armMetaHeartRefractory failed');
    return true; // fail-open: still allow this elevate
  }
}

export async function isMetaHeartArmed(chatId: number): Promise<boolean> {
  try {
    return !!(await getRedis().get(armKey(chatId)));
  } catch {
    return false;
  }
}

async function isCodeActBusySafe(chatId: number): Promise<boolean> {
  try {
    const { isCodeActBusy } = await import('../subagent/task-store.js');
    return await isCodeActBusy(chatId);
  } catch {
    return false;
  }
}

async function isRecentBotReply(chatId: number): Promise<boolean> {
  const refractoryMs = refractoryPolicy(chatId).ms;
  if (refractoryMs <= 0) return false;
  try {
    const { getChatState } = await import('../pipeline/timing/chat-runtime.js');
    const tstate = await getChatState(chatId);
    const at = tstate?.lastBotReplyAt;
    return !!(at && at > 0 && Date.now() - at < refractoryMs);
  } catch {
    return false;
  }
}

/** Block another Heart elevate (parallel LLM / pile-on). */
export async function shouldSuppressMetaHeartElevate(chatId: number): Promise<boolean> {
  if (await isCodeActBusySafe(chatId)) return true;
  if (await isMetaHeartArmed(chatId)) return true;
  return isRecentBotReply(chatId);
}

/**
 * Block another CodeAct for Heart/L1. Does NOT check arm — otherwise the first
 * dispatch after elevate would never run.
 */
export async function shouldSuppressMetaHeartDispatch(chatId: number): Promise<boolean> {
  if (await isCodeActBusySafe(chatId)) return true;
  return isRecentBotReply(chatId);
}

/** @deprecated alias — prefer elevate vs dispatch helpers */
export async function shouldSuppressMetaHeartSpeak(chatId: number): Promise<boolean> {
  return shouldSuppressMetaHeartDispatch(chatId);
}
