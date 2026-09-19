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
        const { markDmEver } = await import('../tracking/dm-state.js');
        markDmEver(formatted.uid);
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

  // Reply-outcome observation. The legacy pipeline does this in
  // pipeline/stages/bookkeeping.ts; Meta skips that stage entirely, so without
  // this hook the outcomes of every conversation reply sent on the main path
  // would never resolve — the self-history facts shown to the model would stay
  // "unknown" forever, and mood/relationship effects would never apply.
  if (env().OUTCOME_TRACKING_ENABLED && formatted.uid > 0 && !formatted.isBot) {
    void (async () => {
      try {
        const [{ checkOutcome, generateReflection }, { getBotIdentity }, { callWithFallback }] =
          await Promise.all([
            import('../tracking/outcome.js'),
            import('../bot/bot.js'),
            import('../ai/fallback.js'),
          ]);
        const { needsReflection } = await checkOutcome(chatId, formatted, getBotIdentity().username);
        if (!needsReflection) return;
        await generateReflection(chatId, async (prompt) => {
          try {
            const result = await callWithFallback({
              usage: 'summarize',
              messages: [{ role: 'user', content: prompt }],
              maxTokens: 300,
              temperature: 0.3,
            });
            return result.content;
          } catch (err) {
            logger.warn({ err, chatId }, 'Meta: reflection AI call failed');
            return null;
          }
        });
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta: outcome check failed (non-critical)');
      }
    })();
  }

  // World facts: record what Telegram reports about this chat (title, type,
  // username, description) as host-observable world entities. The World
  // projection had a consumer but no producer — nothing ever emitted
  // `world_change`, so `world_entities` stayed empty. Cached for 30 min inside
  // the module, so this is one getChat per chat per half hour, not per message.
  if (env().WORLD_FACTS_ENABLED) {
    void import('../agent/world-facts.js')
      .then(({ observeAndRecordChatFacts }) => observeAndRecordChatFacts(chatId, true))
      .catch((err) => logger.debug({ err, chatId }, 'Meta: world facts failed (non-critical)'));
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
