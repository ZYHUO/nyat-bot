// Side effects Meta path must keep when skipping processPipeline bookkeeping.
import type { FormattedMessage } from '../shared/types.js';
import type { UpdateLike } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

/** Fire-and-forget hooks that pipeline used to run before judge. */
export function runMetaBookkeepingHooks(chatId: number, formatted: FormattedMessage): void {
  // DM affinity + pending flush
  if (chatId > 0 && formatted.uid > 0 && !formatted.isBot) {
    void (async () => {
      try {
        const { markDmEver, markPmDmOpen } = await import('../tracking/dm-state.js');
        markDmEver(formatted.uid);
        markPmDmOpen(formatted.uid);
        const { countDmPending } = await import('../tracking/dm-pending.js');
        if (countDmPending(formatted.uid) > 0) {
          const { flushDmPendingOnInbound } = await import('../pipeline/dm-proactive.js');
          await flushDmPendingOnInbound(formatted.uid);
        }
      } catch (err) {
        logger.debug({ err }, 'Meta: DM affinity hook failed');
      }
    })();
  }

  // DM wake poke
  if (chatId > 0 && env().SLEEP_WAKE_ON_DM_ENABLED) {
    void import('../tracking/sleep.js')
      .then(({ pokeGlobalWake }) => pokeGlobalWake('dm'))
      .catch(() => {});
  }
}

export type MetaSleepVerdict = 'continue' | 'queued' | 'silent';

/** Sleep Stage B analogue for Meta Attention. */
export async function metaSleepGate(opts: {
  chatId: number;
  formatted: FormattedMessage;
  isDirect: boolean;
  layer: 'L0' | 'L1' | 'L2';
  update: UpdateLike;
  messageId: number;
}): Promise<MetaSleepVerdict> {
  const { chatId, formatted, isDirect, layer, update, messageId } = opts;
  try {
    const { getSleepPhase, sleepWakeDecision } = await import('../tracking/sleep.js');
    const phase = await getSleepPhase();
    if (phase === 'awake') return 'continue';

    // Passive L2 while asleep: don't burn Attention / queue (pipeline Stage A would often silence).
    if (layer === 'L2' && !isDirect) return 'silent';

    const rule =
      chatId > 0
        ? 'private_chat'
        : isDirect
          ? 'mention_self'
          : undefined;
    const verdict = await sleepWakeDecision(chatId, formatted.uid, rule, phase);
    if (verdict === 'wake' || verdict === 'pass') {
      const { clearSleepPending } = await import('../tracking/sleep-queue.js');
      if (verdict === 'wake') await clearSleepPending(chatId);
      return 'continue';
    }

    // queue
    const { pushSleepPending } = await import('../tracking/sleep-queue.js');
    await pushSleepPending(chatId, {
      entry: {
        update,
        chatId,
        messageId,
        enqueuedAt: Date.now(),
        waitReplay: true,
        sleepCatchup: true,
      },
      rule: rule ?? 'passive_chat',
      ts: Date.now(),
    });
    return 'queued';
  } catch (err) {
    logger.debug({ err, chatId }, 'Meta sleep gate failed — continue');
    return 'continue';
  }
}

export function messageHasMedia(formatted: FormattedMessage): boolean {
  return !!(
    formatted.imageFileId ||
    formatted.sticker ||
    formatted.audioFileId ||
    formatted.voiceFileId ||
    formatted.documentFileId ||
    formatted.videoFileId ||
    formatted.videoNoteFileId ||
    formatted.replyTo?.imageFileId
  );
}
