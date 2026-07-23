/**
 * Same-speaker burst: while we are answering uid X (L0 coalesce / in-flight CodeAct),
 * their next bubbles without @ must still elevate to L0 — otherwise Heart busy/refractory
 * drops follow-ups like 「笨猫」→「你钱包还有多少」.
 */

import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { getGlobalState } from './global-state.js';

const KEY = (chatId: number) => `xxb:meta:speaker_burst:${chatId}`;

function defaultTtlSec(): number {
  return Math.max(8, Math.ceil(env().META_L0_COALESCE_MS / 1000) + 5);
}

/** Remember that we are mid-burst for this uid in the group. */
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

/** True → force-ingest as L0 same_speaker_burst (skip Heart silence). */
export async function shouldForceSameSpeakerL0(chatId: number, uid: number): Promise<boolean> {
  if (await isSpeakerBurstOpen(chatId, uid)) return true;
  return isInFlightCodeActForUser(chatId, uid);
}
