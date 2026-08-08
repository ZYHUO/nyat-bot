// ────────────────────────────────────────
// Meta ingress feature intercepts — NL/gacha/game/DM-relay that must not
// wait for CodeAct (and must not be lost when Meta owns the chat).
// Returns:
//   'legacy'  — fall through to pipeline (e.g. /checkin NL needs reply LLM inject)
//   'handled' — already replied / done; caller must not Attention-ingest
//   'continue'— normal Meta Attention path
// ────────────────────────────────────────

import type { FormattedMessage } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { sender } from '../pipeline/shared.js';
import { getMuteState } from '../tracking/user-profile.js';
import { detectCommandIntent } from '../pipeline/nl-commands.js';
import { dispatchCommand } from '../pipeline/stages/intercepts.js';
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

  return 'continue';
}
