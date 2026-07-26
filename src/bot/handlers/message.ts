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
    if (await isDuplicate(chatId, messageId, isEdit, msg.edit_date)) return;
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

        // Passive group chat: Heart decides是否插话 → 升 L1 再进 Meta。
        // Heart 本身就是 gate（含 cooldown/engagement/wait/pass），放行后
        // 不再跑 Meta timing——否则会和 Heart 双重否决、把已批准的插话掐掉。
        // Direct/L0 仍直通 Meta；HEART 关时保持旧 L2 硬丢。
        //
        // Same-speaker burst: 正在回这个人的 L0 / CodeAct 占线时，后续无 @ 气泡
        // 也升 L0（否则 Heart busy 会把「钱包还有多少」整句丢掉）。
        if (!isDirect && layerDec.layer !== 'L0' && userId && userId > 0) {
          try {
            const { shouldForceSameSpeakerL0, markSpeakerBurst } = await import(
              '../../meta/speaker-burst.js'
            );
            if (await shouldForceSameSpeakerL0(chatId, userId)) {
              await getAttentionAccumulator().ingestAsync({
                chatId,
                layer: 'L0',
                reason: 'same_speaker_burst',
                messageId,
                userId,
                textPreview,
                pressure: 100,
                payload: {
                  username: fm.username || undefined,
                  fullName: fm.fullName || undefined,
                  ...(fm.replyTo
                    ? {
                        replyTo: {
                          messageId: fm.replyTo.messageId,
                          uid: fm.replyTo.uid,
                          fullName: fm.replyTo.fullName,
                          textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                        },
                      }
                    : {}),
                },
              });
              await markSpeakerBurst(chatId, userId);
              logger.info(
                { chatId, messageId, uid: userId },
                'Meta attention ingested (same_speaker_burst)',
              );
              return 'done';
            }
          } catch (err) {
            logger.debug({ err, chatId, messageId }, 'same_speaker_burst check failed — Heart path');
          }
        }

        if (!isDirect && layerDec.layer !== 'L0') {
          const { env } = await import('../../env.js');
          if (env().HEART_ENABLED) {
            void (async () => {
              try {
                const { evaluateMetaHeart } = await import('../../meta/heart-adapter.js');
                const heart = await evaluateMetaHeart({
                  chatId,
                  formatted: fm,
                  layer: layerDec.layer,
                });
                if (heart.verdict !== 'allow') return;

                const elevLayer = heart.layer;
                const elevReason = heart.reason;
                const elevBoost = heart.pressureBoost ?? 0;

                const basePressure = elevLayer === 'L0' ? 100 : elevLayer === 'L1' ? 70 : 30;
                await getAttentionAccumulator().ingestAsync({
                  chatId,
                  layer: elevLayer,
                  reason: elevReason,
                  messageId,
                  userId,
                  textPreview,
                  pressure: basePressure + elevBoost,
                  payload: {
                    username: fm.username || undefined,
                    fullName: fm.fullName || undefined,
                    heartPath: heart.path,
                    ...(fm.replyTo
                      ? {
                          replyTo: {
                            messageId: fm.replyTo.messageId,
                            uid: fm.replyTo.uid,
                            fullName: fm.replyTo.fullName,
                            textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                          },
                        }
                      : {}),
                  },
                });
                logger.info(
                  { chatId, messageId, layer: elevLayer, reason: elevReason },
                  'Meta attention ingested (heart)',
                );
              } catch (err) {
                // Infra failure ≠ Heart "pass". Fail-open once into Attention so the
                // msg isn't silently lost; gap-fill may still dispatch.
                logger.warn({ err, chatId, messageId }, 'Meta heart path failed — soft ingest');
                try {
                  await getAttentionAccumulator().ingestAsync({
                    chatId,
                    layer: 'L1',
                    reason: 'heart:infra_fail',
                    messageId,
                    userId,
                    textPreview,
                    pressure: 55,
                    payload: {
                      username: fm.username || undefined,
                      fullName: fm.fullName || undefined,
                      ...(fm.replyTo
                        ? {
                            replyTo: {
                              messageId: fm.replyTo.messageId,
                              uid: fm.replyTo.uid,
                              fullName: fm.replyTo.fullName,
                              textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                            },
                          }
                        : {}),
                    },
                  });
                } catch (err2) {
                  logger.warn({ err: err2, chatId, messageId }, 'Meta heart soft ingest failed');
                }
              }
            })();
            return 'done';
          }

          // Heart off: L2 旁观硬丢（旧行为）
          if (layerDec.layer === 'L2') {
            logger.debug({ chatId, messageId }, 'Meta path: L2 drop (no Attention)');
            return 'done';
          }
        }

        // Timing gate — only for L0/direct (and Heart-off L1). Heart path skips this.
        try {
          const { evaluateMetaTiming } = await import('../../meta/timing-adapter.js');
          const timing = await evaluateMetaTiming({
            chatId,
            formatted: fm,
            isDirect,
            layer: layerDec.layer,
            directKind,
          });
          if (timing.verdict === 'silence') {
            logger.info(
              { chatId, messageId, layer: layerDec.layer, reason: timing.reason },
              'Meta path: timing gate silence',
            );
            return 'done';
          }
        } catch (err) {
          logger.warn({ err, chatId }, 'Meta timing gate failed — fail-open to Attention');
        }

        // Typing starts at CodeAct (executor heartbeat), not here — coalesce may
        // hold L0/L1 for META_L0_COALESCE_MS and premature typing looks stuck.

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
          payload: {
            username: fm.username || undefined,
            fullName: fm.fullName || undefined,
            ...(fm.replyTo
              ? {
                  replyTo: {
                    messageId: fm.replyTo.messageId,
                    uid: fm.replyTo.uid,
                    fullName: fm.replyTo.fullName,
                    textSnippet: (fm.replyTo.textSnippet ?? '').slice(0, 200),
                  },
                }
              : {}),
          },
        });
        if (layerDec.layer === 'L0' && userId && userId > 0 && chatId < 0) {
          try {
            const { markSpeakerBurst } = await import('../../meta/speaker-burst.js');
            await markSpeakerBurst(chatId, userId);
          } catch {
            /* non-critical */
          }
        }
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
