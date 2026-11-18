import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { incrCounter } from '../metrics/registry.js';
import { isTelegramHeartBatchChat } from './flags.js';
import type { TelegramHeartCandidate, TelegramHeartClaim } from './telegram-heart-store.js';

export interface WaitRecheckControl {
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
  beginEffects(): Promise<boolean>;
}

const POLL_MS = 1_000;
const MAX_HANDOFF_MS = 100_000; // A vanished evaluator's physical lease lasts 90 seconds.
let localWaitWork = 0;

function yieldWait(reason: string): void {
  incrCounter('meta_wait_recheck_yield_total', { reason });
}

/** WAIT and fresh batches share a finite model budget and one chat lease.
 * Only a timer already claimed by Redis can request a turn. Queueing polls
 * generation/liveness once per second; message ingress never wakes the worker. */
export async function withWaitRecheckSlot(candidate: TelegramHeartCandidate,
  work: (control?: WaitRecheckControl) => Promise<void>, generationCurrent: () => Promise<boolean>): Promise<void> {
  if (!isTelegramHeartBatchChat(candidate.chatId)) return work();
  const workers = env().QUEUE_CONCURRENCY;
  // Leave at least one ordinary queue slot on multi-slot workers. A single-
  // slot worker can review an immediately free chat, but never parks for one.
  if (localWaitWork >= Math.max(1, Math.min(2, workers - 1))) return yieldWait('worker_capacity');
  localWaitWork++;
  try {
    const store = await import('./telegram-heart-store.js');
    const ticket = { scope: store.telegramHeartScope(candidate), token: randomUUID() };
    const deadline = Date.now() + MAX_HANDOFF_MS;
    let registered = false;
    let claim: TelegramHeartClaim | undefined;
    try {
      for (let elapsed = 0; elapsed < MAX_HANDOFF_MS; elapsed += POLL_MS) {
        if (!isTelegramHeartBatchChat(candidate.chatId) || !await generationCurrent()) return yieldWait('obsolete');
        if (Date.now() >= deadline) break;
        const result = store.claimTelegramHeartRecheck(ticket, registered);
        if (result.status === 'claimed') { claim = result.claim; break; }
        if (result.status === 'capacity' || result.status === 'obsolete') return yieldWait(result.status);
        registered = result.status === 'reserved';
        if (workers <= 1) return yieldWait('worker_capacity');
        await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
      }
    } finally {
      if (!claim && registered) store.releaseTelegramHeartRecheck(ticket);
    }
    if (!claim) return yieldWait('handoff_deadline');
    if (registered) incrCounter('meta_wait_recheck_handoffs_total', {});
    await runClaim(claim, candidate.chatId, work, generationCurrent, store);
  } finally {
    localWaitWork--;
  }
}

async function runClaim(owned: TelegramHeartClaim, chatId: number, work: (control?: WaitRecheckControl) => Promise<void>,
  generationCurrent: () => Promise<boolean>, store: typeof import('./telegram-heart-store.js')): Promise<void> {
  const controller = new AbortController();
  const check = async (effects = false): Promise<boolean> => {
    if (controller.signal.aborted) return false;
    const valid = isTelegramHeartBatchChat(chatId) && store.checkTelegramHeartClaim(owned, effects);
    if (!valid) controller.abort();
    return valid;
  };
  const heartbeat = setInterval(() => {
    try {
      // Even cancelled work may still be awaiting a provider's abort. Keep its
      // physical slot occupied rather than allowing a new local model overlap.
      if (!store.renewTelegramHeartClaimOwnership(owned) || !store.checkTelegramHeartClaim(owned)) controller.abort();
    } catch { controller.abort(); }
  }, 2_000);
  heartbeat.unref?.();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  timeout.unref?.();
  let outcome: 'settled' | 'aborted' | 'failed' = 'failed';
  try {
    if (await generationCurrent() && await check()) {
      await work({ signal: controller.signal, isCurrent: () => check(), beginEffects: () => check(true) });
    } else yieldWait('obsolete');
    outcome = controller.signal.aborted ? 'aborted' : 'settled';
  } finally {
    clearInterval(heartbeat); clearTimeout(timeout);
    store.finishTelegramHeartBatch(owned, outcome);
  }
}
