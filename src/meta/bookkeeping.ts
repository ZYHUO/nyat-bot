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

  // Topic watch notifications
  if (chatId < 0 && !formatted.isBot && formatted.textContent) {
    void (async () => {
      try {
        const { checkWatches } = await import('../tracking/topic-watch.js');
        const { sendMessage } = await import('../bot/sender/telegram.js');
        const watchers = checkWatches(chatId, formatted.textContent, formatted.uid);
        for (const uid of watchers) {
          sendMessage(uid, '📢 有人聊到了你追踪的话题喵~').catch(() => {});
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta: topic watch failed');
      }
    })();
  }

  // Relay queue on_speak
  if (chatId < 0 && !formatted.isBot && formatted.uid) {
    void (async () => {
      try {
        const { getPendingRelayForTarget, deliverRelay, setRelayStatus } = await import(
          '../pipeline/dm-relay/relay-queue.js'
        );
        const { recheckDeliverySafety } = await import('../pipeline/dm-relay/safety.js');
        const { sendMessage } = await import('../bot/sender/telegram.js');
        const pendingRelays = getPendingRelayForTarget(formatted.uid, chatId);
        for (const relay of pendingRelays) {
          try {
            const delivered = deliverRelay(relay.id);
            if (!delivered) continue;
            if (!(await recheckDeliverySafety(relay.sender_id, chatId))) {
              setRelayStatus(relay.id, 'cancelled');
              continue;
            }
            const relayText = `${formatted.fullName}，有人让本喵转告你：${relay.content}`;
            await sendMessage(chatId, relayText);
            try {
              await sendMessage(relay.sender_id, `✅ 你的捎话已送达 ${formatted.fullName} 喵~`);
            } catch {
              /* blocked */
            }
            logger.info({ relayId: relay.id, targetUid: formatted.uid, chatId }, 'Meta: on-speak relay delivered');
          } catch (err) {
            logger.error({ err, relayId: relay.id }, 'Meta: on-speak relay failed');
          }
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta: relay on_speak check failed');
      }
    })();
  }

  // Profile notification hook
  if (chatId < 0 && !formatted.isBot && formatted.uid) {
    void import('../pipeline/dm-relay/handlers/profile.js')
      .then(({ checkProfileNotifications }) => checkProfileNotifications(chatId, formatted))
      .catch((err) => logger.debug({ err, chatId }, 'Meta: profile notification failed'));
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
