/**
 * Same-speaker burst: while answering uid X (short L0 coalesce / in-flight CodeAct),
 * at most ONE follow-up without @ may elevate to L0 — so 「笨猫」→「钱包还有多少」
 * is not dropped by Heart busy, without machine-gunning every later bubble.
 */

import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { getGlobalState } from './global-state.js';

const KEY = (chatId: number) => `xxb:meta:speaker_burst:${chatId}`;
const ONCE_KEY = (chatId: number) => `xxb:meta:speaker_burst_once:${chatId}`;

function defaultTtlSec(): number {
  return Math.max(8, Math.ceil(env().META_L0_COALESCE_MS / 1000) + 5);
}

/** Remember that we just took an L0 from this uid (coalesce window only). */
export async function markSpeakerBurst(
  chatId: number,
  uid: number,
  ttlSec?: number,
): Promise<void> {
  if (!(chatId < 0) || !(uid > 0)) return;
  try {
    await getRedis().set(KEY(chatId), String(uid), 'EX', ttlSec ?? defaultTtlSec());
  } catch {
    /* non-critical */
  }
}

export async function isSpeakerBurstOpen(chatId: number, uid: number): Promise<boolean> {
  if (!(chatId < 0) || !(uid > 0)) return false;
  try {
    const v = await getRedis().get(KEY(chatId));
    return v === String(uid);
  } catch {
    return false;
  }
}

/** Queued/running CodeAct already targeting this user. */
export function isInFlightCodeActForUser(chatId: number, uid: number): boolean {
  if (!(uid > 0)) return false;
  try {
    const now = Date.now();
    return getGlobalState()
      .listTasks(chatId)
      .some(
        (t) =>
          (t.status === 'queued' || t.status === 'running') &&
          t.targetUserId === uid &&
          now - t.createdAt < 180_000,
      );
  } catch {
    return false;
  }
}

/** NX: only the first follow-up in a burst window may force-L0. */
async function tryClaimBurstOnce(chatId: number, uid: number, ttlSec: number): Promise<boolean> {
  try {
    const ok = await getRedis().set(ONCE_KEY(chatId), String(uid), 'EX', ttlSec, 'NX');
    return ok === 'OK';
  } catch {
    return true; // fail-open once
  }
}

/**
 * True → force-ingest as L0 same_speaker_burst (skip Heart silence).
 * Caps at one forced elevate per chat burst — extra bubbles stay on Heart path.
 */
export async function shouldForceSameSpeakerL0(chatId: number, uid: number): Promise<boolean> {
  if (!(chatId < 0) || !(uid > 0)) return false;

  if (isInFlightCodeActForUser(chatId, uid)) {
    // One follow-up while we are already answering them (e.g. 钱包 after 笨猫).
    return tryClaimBurstOnce(chatId, uid, 180);
  }

  if (await isSpeakerBurstOpen(chatId, uid)) {
    // One follow-up inside the short coalesce window after their L0.
    return tryClaimBurstOnce(chatId, uid, defaultTtlSec());
  }

  return false;
}

/**
 * Drop burst markers when CodeAct finishes so we don't keep elevating.
 * CAS (compare-and-swap): only delete KEY/ONCE_KEY if they still belong to
 * `uid`. Without this, a new follow-up message that claimed ONCE_KEY *after*
 * the CodeAct started but *before* it finishes would have its claim wiped,
 * allowing a second follow-up to also force-L0 → duplicate reply bubble.
 */
export async function clearSpeakerBurst(chatId: number, uid?: number): Promise<void> {
  if (!(chatId < 0)) return;
  try {
    if (uid && uid > 0) {
      // CAS: only delete if the stored value matches this uid's claim.
      const redis = getRedis();
      const val = await redis.get(KEY(chatId));
      if (val === String(uid)) {
        await redis.del(KEY(chatId));
      }
      const onceVal = await redis.get(ONCE_KEY(chatId));
      if (onceVal === String(uid)) {
        await redis.del(ONCE_KEY(chatId));
      }
    } else {
      // No uid = legacy caller: unconditional clear (backward compat).
      await getRedis().del(KEY(chatId), ONCE_KEY(chatId));
    }
  } catch {
    /* non-critical */
  }
}
