// ────────────────────────────────────────
// Meta ingress feature intercepts — NL/gacha/game/DM-relay that must not
// wait for CodeAct (and must not be lost when Meta owns the chat).
// Returns:
//   'legacy'  — fall through to pipeline (e.g. /checkin NL needs reply LLM inject)
//   'handled' — already replied / done; caller must not Attention-ingest
//   'continue'— normal Meta Attention path
// ────────────────────────────────────────

import type { FormattedMessage } from '../shared/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { sender } from '../pipeline/shared.js';
import { getMuteState } from '../tracking/user-profile.js';
import { detectCommandIntent } from '../pipeline/nl-commands.js';
import { dispatchCommand } from '../pipeline/stages/intercepts.js';
import { detectConsentReply, setConsent } from '../pipeline/dm-relay/consent.js';
import { detectDmIntentWithAI } from '../pipeline/dm-relay/detector.js';
import { handleDmRelay } from '../pipeline/dm-relay/relay.js';
import { hasActiveGame, playGame } from '../pipeline/games/manager.js';
import { getBotUid } from '../bot/bot.js';


export type MetaIngressResult = 'legacy' | 'handled' | 'continue';

/**
 * Cheap pre-bookkeeping classify: messages that must hit legacy reply injection
 * (checkin/stats) or explicit slash should fall through before Meta ctx writes.
 */
export function metaNeedsLegacyPipeline(
  chatId: number,
  text: string,
  isDirect: boolean,
): boolean {
  const raw = (text || '').trim();
  if (/^\s*\//.test(raw)) return true;
  const addressed = chatId > 0 || isDirect;
  if (!addressed) return false;
  const intent = detectCommandIntent(raw);
  return intent?.kind === 'llm';
}

/** Mute gate mirrored from pipeline.ts (level 2 always; level 1 unless direct). */
export function metaMuteBlocksReply(
  chatId: number,
  formatted: FormattedMessage,
  isDirect: boolean,
): boolean {
  if (formatted.isAnonymous || formatted.uid <= 0) return false;
  const mute = getMuteState(chatId, formatted.uid);
  if (mute.level === 2) return true;
  if (mute.level === 1 && !isDirect && chatId < 0) return true;
  return false;
}

export async function tryMetaIngressIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  opts: { isDirect: boolean },
): Promise<MetaIngressResult> {
  const text = (formatted.textContent || '').trim();
  const addressed = chatId > 0 || opts.isDirect;

  // ── DM pending confide ──
  if (chatId > 0 && text) {
    try {
      const { hasPendingConfide, clearPendingConfide, doConfide } = await import(
        '../pipeline/dm-relay/handlers/confide.js'
      );
      if (await hasPendingConfide(formatted.uid)) {
        await clearPendingConfide(formatted.uid);
        const { resolveGroup, savePendingGroupSelection } = await import(
          '../pipeline/dm-relay/group-resolver.js'
        );
        const result = await resolveGroup(formatted.uid);
        if (result.ok) {
          try {
            await doConfide(
              { uid: formatted.uid, chatId, messageId: formatted.messageId },
              sender,
              text,
              result.group.chatId,
            );
          } catch (err) {
            logger.error({ err, chatId }, 'Meta: pending confide failed');
            await sender.sendDirect(chatId, '处理失败了喵，稍后再试~', formatted.messageId);
          }
        } else if (result.reason === 'multiple_groups') {
          await savePendingGroupSelection(formatted.uid, {
            intent: 'confide',
            groups: result.groups,
            content: text,
          });
          await sender.sendDirect(chatId, result.reply, formatted.messageId);
        } else {
          await sender.sendDirect(chatId, result.reply, formatted.messageId);
        }
        return 'handled';
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: confide pending check failed');
    }
  }

  // ── DM pending group selection (numeric reply) ──
  if (chatId > 0 && text) {
    const num = parseInt(text, 10);
    if (!isNaN(num) && num > 0 && text === String(num)) {
      try {
        const { getPendingGroupSelection, clearPendingGroupSelection } = await import(
          '../pipeline/dm-relay/group-resolver.js'
        );
        const { handlePendingGroupSelection } = await import('../pipeline/dm-relay/relay.js');
        const pending = await getPendingGroupSelection(formatted.uid);
        if (pending && num <= pending.groups.length) {
          const selectedGroup = pending.groups[num - 1]!;
          try {
            await handlePendingGroupSelection(
              chatId,
              formatted,
              selectedGroup,
              pending.intent,
              pending.targetHandle,
              pending.content,
            );
          } catch (err) {
            logger.error({ err, chatId }, 'Meta: pending group selection failed');
            await sender.sendDirect(chatId, '处理失败了喵，稍后再试~', formatted.messageId);
          }
          await clearPendingGroupSelection(formatted.uid);
          return 'handled';
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta: group selection check failed');
      }
    }
  }

  // ── DM verification lock ──
  if (chatId > 0) {
    try {
      const { getRedis } = await import('../db/redis.js');
      const active = await getRedis().get(`xxb:verify:active:${formatted.uid}`);
      if (active) {
        await sender.sendDirect(
          chatId,
          '🔐 你正在进行入群验证，请先回答验证问题。验证完成后才能继续对话喵~',
          formatted.messageId,
        );
        return 'handled';
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: verify check failed');
    }
  }

  // ── Active party/guess game input ──
  if (
    chatId < 0 &&
    hasActiveGame(chatId) &&
    !formatted.isBot &&
    formatted.replyTo?.uid === getBotUid()
  ) {
    const gameResult = playGame(chatId, formatted.uid, formatted.textContent || '');
    if (gameResult) {
      await sender.sendDirect(chatId, gameResult, formatted.messageId);
      return 'handled';
    }
  }

  // ── Consent reply (group, reply to bot consent ask) ──
  if (chatId < 0 && opts.isDirect && formatted.replyTo) {
    const consentResult = detectConsentReply(
      formatted.textContent || '',
      formatted.replyTo.textSnippet,
    );
    if (consentResult) {
      setConsent(chatId, formatted.uid, consentResult.approved ? 'approved' : 'denied');
      await sender.sendDirect(
        chatId,
        consentResult.approved ? '好的，已记录同意~' : '好的，不会转发消息给你~',
        formatted.messageId,
      );
      return 'handled';
    }
  }

  // ── NL commands (gacha/game/watch/help…) — checkin/stats already routed legacy ──
  if (!formatted.isAnonymous && addressed && text && !text.startsWith('/')) {
    const intent = detectCommandIntent(text);
    if (intent?.kind === 'intercept') {
      if (await dispatchCommand(chatId, formatted, intent.cmd, intent.arg)) {
        logger.info({ chatId, cmd: intent.cmd }, 'Meta: NL command dispatched');
        return 'handled';
      }
    }
  }

  // ── DM relay AI intent (private only) ──
  if (chatId > 0 && text) {
    try {
      const { sendChatAction } = await import('../bot/sender/telegram.js');
      await sendChatAction(chatId, 'typing');
      const intent = await detectDmIntentWithAI(text, env().BOT_USERNAME);
      if (intent.type !== 'normal_chat') {
        try {
          const { markIntentHandled } = await import('../pipeline/dm-relay/post-action.js');
          await markIntentHandled(formatted.uid, text);
        } catch {
          /* non-critical */
        }
        try {
          await handleDmRelay(chatId, formatted, intent);
        } catch (err) {
          logger.error({ err, chatId }, 'Meta: DM relay failed');
          await sender.sendDirect(chatId, '处理失败了喵，稍后再试~', formatted.messageId);
        }
        return 'handled';
      }
    } catch (err) {
      logger.warn({ err, chatId }, 'Meta: DM intent detect failed — continue Meta chat');
    }
  }

  return 'continue';
}
