import type { Bot, Context } from 'grammy';
import { logger } from '../../shared/logger.js';
import { isDuplicate } from '../middleware/dedup.js';
import { isRateLimited } from '../middleware/rate-limit.js';
import { enqueue } from '../../queue/producer.js';
import { detectDirectInteraction } from '../../pipeline/timing/direct-interaction.js';
import { isTurnActorChat } from '../../pipeline/turn/actor.js';
import { appendPending } from '../../pipeline/turn/buffer.js';
import { interruptGeneration } from '../../pipeline/turn/abort-registry.js';
import { bumpFocus } from '../../pipeline/turn/focus.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { getBotIdentity } from '../bot.js';
import { formatMessage } from '../../pipeline/formatter.js';
import { detectReplyObligation, isObligationCancelMessage } from '../../pipeline/turn/obligation-detect.js';
import { saveObligation, setActiveObligation, supersedeActiveObligation, getActiveObligationId, getObligation, updateObligationState } from '../../pipeline/turn/obligation-store.js';
import { isMetaSubagentChat, getAttentionAccumulator } from '../../meta/index.js';
import {
  metaNeedsLegacyPipeline,
  metaMuteBlocksReply,
  tryMetaIngressIntercepts,
} from '../../meta/ingress-intercepts.js';
import { classifyAttentionLayer } from '../../meta/classify-layer.js';
import {
  runMetaBookkeepingHooks,
  metaSleepGate,
  messageHasMedia,
} from '../../meta/bookkeeping.js';

async function handleUpdate(ctx: Context): Promise<void> {
  const msg = ctx.message ?? ctx.editedMessage ?? ctx.channelPost ?? ctx.editedChannelPost;
  if (!msg) return;

  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const userId = msg.from?.id;
  const isEdit = !!(ctx.editedMessage ?? ctx.editedChannelPost);

  try {
    if (await isDuplicate(chatId, messageId, isEdit)) return;
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'Dedup check failed, proceeding');
  }

  try {
    if (userId && (await isRateLimited(userId))) return;
  } catch (err) {
    logger.warn({ err, userId }, 'Rate limit check failed, proceeding');
  }

  const senderChat = msg.sender_chat;
  const senderChatUsername = senderChat && 'username' in senderChat ? senderChat.username : undefined;
  const senderChatTitle = senderChat && 'title' in senderChat ? senderChat.title : undefined;
  const isAnonymousAdmin = msg.from?.id === 1087968824;
  const displayName = (isAnonymousAdmin || !msg.from)
    ? (senderChatTitle ?? senderChatUsername ?? 'channel')
    : (msg.from.username ?? msg.from.first_name ?? 'unknown');

  logger.debug(
    {
      chatId,
      messageId,
      from: displayName,
      text: (msg.text ?? msg.caption)?.slice(0, 80),
    },
    'Message received',
  );

  const baseData = {
    type: 'message' as const,
    chatId,
    messageId,
    isEdit,
    update: ctx.update,
    enqueuedAt: Date.now(),
  };

  // Meta+Subagent path: feed Attention; skip legacy reply path (avoid double reply).
  // Slash / checkin·stats NL → legacy. Gacha/game/DM-relay → Meta ingress intercepts.
  if (isMetaSubagentChat(chatId) && !isEdit) {
    const botIdentity = getBotIdentity();
    const directKind = detectDirectInteraction(ctx.update, {
      botUid: botIdentity.uid,
      botUsername: botIdentity.username,
      botNicknames: botIdentity.nicknames,
      editByContentOnly: true,
    });
    const isDirect = directKind !== null;
    const rawText = msg.text ?? msg.caption ?? '';

    // Fall through BEFORE Meta bookkeeping to avoid duplicate Redis/Qdrant writes.
    if (metaNeedsLegacyPipeline(chatId, rawText, isDirect)) {
      logger.info({ chatId, messageId }, 'Meta path: slash/checkin-stats → legacy pipeline');
      // fall through
    } else {
      const formatted = formatMessage(ctx.update);
      if (!formatted) {
        logger.debug({ chatId, messageId }, 'Meta path: formatMessage empty, drop');
        return;
      }

      const finishMeta = async (fm: typeof formatted): Promise<'done' | 'legacy'> => {
        try {
          const { addMessage } = await import('../../pipeline/context/manager.js');
          await addMessage(chatId, fm);
        } catch (err) {
          logger.debug({ err, chatId }, 'Meta path: addMessage failed (non-critical)');
        }
        void import('../../memory/chroma.js')
          .then(({ memorizeMessage }) => memorizeMessage(chatId, fm))
          .catch(() => {});
        void import('../../tracking/activity.js')
          .then(({ recordMessage }) => recordMessage(chatId, fm.messageId, fm.uid))
          .catch(() => {});
        try {
          const { recordUserMessage } = await import('../../tracking/user-profile.js');
          if (fm.role === 'user' && fm.uid > 0) {
            recordUserMessage(
              chatId,
              fm.uid,
              fm.username,
              fm.fullName,
              fm.senderTag,
              fm.textContent,
            );
          }
        } catch {
          /* non-critical */
        }

        runMetaBookkeepingHooks(chatId, fm);

        if (metaMuteBlocksReply(chatId, fm, isDirect)) {
          logger.debug({ chatId, uid: fm.uid }, 'Meta path: muted, skip Attention');
          return 'done';
        }

        const intercept = await tryMetaIngressIntercepts(chatId, fm, { isDirect });
        if (intercept === 'handled') {
          logger.info({ chatId, messageId }, 'Meta path: feature intercept handled');
          return 'done';
        }
        if (intercept === 'legacy') return 'legacy';

        const textPreview = (fm.textContent || rawText).slice(0, 200);
        const layerDec = classifyAttentionLayer({
          chatId,
          isDirect,
          directKind,
          text: textPreview,
        });

        const sleep = await metaSleepGate({
          chatId,
          formatted: fm,
          isDirect,
          layer: layerDec.layer === 'L1_CALLBACK' ? 'L1' : layerDec.layer,
          update: ctx.update,
          messageId,
        });
        if (sleep === 'silent' || sleep === 'queued') {
          logger.info({ chatId, messageId, sleep, layer: layerDec.layer }, 'Meta path: asleep');
          return 'done';
        }

        if (layerDec.layer === 'L0' || layerDec.layer === 'L1') {
          void import('../../bot/sender/telegram.js')
            .then(({ sendChatAction }) => sendChatAction(chatId, 'typing'))
            .catch(() => {});
        }

        const basePressure =
          layerDec.layer === 'L0' ? 100 : layerDec.layer === 'L1' ? 60 : 30;
        await getAttentionAccumulator().ingestAsync({
          chatId,
          layer: layerDec.layer,
          reason: layerDec.reason,
          messageId,
          userId,
          textPreview,
          pressure: basePressure + (layerDec.pressureBoost ?? 0),
        });
        logger.info({ chatId, messageId, layer: layerDec.layer }, 'Meta attention ingested');
        return 'done';
      };

      // Vision/sticker off the grammY hot path — ingest text first when media-heavy.
      if (messageHasMedia(formatted)) {
        void (async () => {
          try {
            const { processMedia } = await import('../../pipeline/stages/media.js');
            await processMedia(formatted);
          } catch (err) {
            logger.debug({ err, chatId }, 'Meta path: deferred processMedia failed');
          }
          const result = await finishMeta(formatted);
          if (result === 'legacy') {
            logger.warn({ chatId, messageId }, 'Meta deferred path cannot fall through — drop');
          }
        })();
        return;
      }

      const result = await finishMeta(formatted);
      if (result === 'legacy') {
        logger.info({ chatId, messageId }, 'Meta path: intercept → legacy');
        // fall through
      } else {
        return;
      }
    }
  }

  if (isTurnActorChat(chatId)) {
    const botIdentity = getBotIdentity();
    const directKind = detectDirectInteraction(ctx.update, {
      botUid: botIdentity.uid,
      botUsername: botIdentity.username,
      botNicknames: botIdentity.nicknames,
      editByContentOnly: true,
    });
    const isDirect = directKind !== null;

    const formatted = formatMessage(ctx.update);
    const activeObligationId = await getActiveObligationId(chatId);
    const activeObligation = activeObligationId ? await getObligation(chatId, activeObligationId) : null;
    const isCancel =
      !!formatted &&
      !!activeObligationId &&
      isObligationCancelMessage(formatted, activeObligation ?? undefined);
    if (isCancel && activeObligationId) {
      await updateObligationState(chatId, activeObligationId, 'dropped', { reason: 'user_cancelled' });
    }
    const obligation = formatted && !isCancel
      ? detectReplyObligation({
          chatId,
          message: formatted,
          directKind,
        })
      : null;
    if (obligation) {
      await saveObligation(obligation);
      if (obligation.mustReplyStrong) {
        await supersedeActiveObligation(chatId, obligation.id);
        await setActiveObligation(chatId, obligation.id);
      }
    }

    if (!isEdit) {
      interruptGeneration(chatId, isDirect ? 'direct_message' : 'new_message');
      if (chatId < 0) {
        void bumpFocus(chatId, isDirect ? 'direct_interaction' : 'passive_message').catch(() => {});
      }
    }

    const msgTextRaw = (msg.text ?? msg.caption ?? '').trim();
    const stillTyping =
      !isEdit &&
      msgTextRaw.length > 0 &&
      msgTextRaw.length < 60 &&
      !/[。.!?！？…~〜)）」』"”\]】]$/.test(msgTextRaw);

    await appendPending({
      update: ctx.update,
      chatId,
      messageId,
      enqueuedAt: Date.now(),
      direct: isDirect,
      isEdit,
      obligationId: obligation?.id,
      obligationTargetUid: obligation?.targetUid,
      obligationStrong: obligation?.mustReplyStrong,
    });
    await scheduleTurn(chatId, {
      trigger: isDirect ? 'direct' : 'message',
      direct: isDirect,
      stillTyping,
      noReschedule: isEdit && !isDirect,
      obligationId: obligation?.id,
      obligationTargetUid: obligation?.targetUid,
      obligationStrong: obligation?.mustReplyStrong,
    });
    return;
  }

  await enqueue(baseData);
}

export function registerMessageHandlers(bot: Bot): void {
  bot.on('message', handleUpdate);
  bot.on('edited_message', handleUpdate);
  bot.on('channel_post', handleUpdate);
  bot.on('edited_channel_post', handleUpdate);
}
