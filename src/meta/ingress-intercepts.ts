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
import { env } from '../env.js';


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

  // ── 学到别的 bot 的命令 → 借力代发 ──
  //
  // 2026-09-21：`routeLearnedCommand` 此前**只在 legacy 的
  // `pipeline/stages/intercepts.ts:194`（tryPreMuteIntercepts）里被调**，
  // 而那是 processPipeline 的路——生产主路径 Meta 上 grep 不到它。
  // 结果：`BOT_COMMAND_ROUTER_ENABLED=true` + 26 条 ready 的已学命令，
  // 而 `command-router: delegated learned command` 生产 **0 次**。
  //
  // 和 round 33/35 是同一种病：功能接在了一条生产不走的路上。
  // 接在这儿（Meta 入口），群聊、非 bot、没被寻址时也试一次——
  // 代发本身就是这次的响应，命中就短路。
  if (chatId < 0 && !formatted.isBot && text.length >= 3
      && env().BOT_COMMAND_ROUTER_ENABLED && env().BOT_DELEGATION_ENABLED) {
    try {
      const { routeLearnedCommand } = await import('../pipeline/command-router.js');
      if (await routeLearnedCommand(chatId, formatted)) return 'handled';
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: learned-command router failed (non-critical)');
    }
  }

  // ── 控制指令（别理我 / 可以说话了 / 记住X / 忘掉X）──
  //
  // 2026-09-21：这段逻辑此前**只在 legacy 的 `pipeline/stages/deliver.ts:293`**
  // （`generateAndSendReplies` ← `runPostJudge` ← `processPipeline`）。
  // `classifyDirective` 全库只有一个调用方，就是那一处。
  // 于是生产主路径 Meta 上，用户跟 bot 说"别理我"**完全没反应**——
  // 而这是用户点名要的"前置功能"那一类（和 time gate 同级）。
  //
  // 接在 Meta 入口：群里点名本喵、或私聊、短消息（≤40 字）、非匿名时才分类，
  // 和 legacy 那道闸保持一致（避免给长对话/普通消息加成本）。
  // 命中 → 静默执行 + emoji ack，不 typing、不回复。
  if (
    env().CONTROL_DIRECTIVE_ENABLED && !formatted.isAnonymous &&
    ((chatId < 0 && addressed) || chatId > 0)
  ) {
    const dtext = text.trim();
    if (dtext.length > 0 && dtext.length <= 40) {
      try {
        const { classifyDirective } = await import('../pipeline/directive.js');
        const action = await classifyDirective(dtext);
        if (action) {
          const { executeControlActions } = await import('../pipeline/control-actions.js');
          const ok = await executeControlActions([action], chatId, formatted.uid, formatted.messageId);
          if (ok) {
            logger.info(
              { chatId, action: action.action, target: action.controlTarget ?? 'self' },
              'Meta: control directive executed (silent)',
            );
            return 'handled';
          }
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Meta: directive classify failed (non-critical)');
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
