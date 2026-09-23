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

  // ── 反广告数据采集（per-chat 授权后才记）────────────────────────────
  //
  // 2026-09-22 round 3（用户报「bot 的反 ad 实际并没有工作」）。
  //
  // 病因又是同一个：`noteInbound`（**唯一**的数据写入方）原来只在
  // `pipeline/pipeline.ts:201`——legacy 的 `processPipeline`。而生产人类消息在
  // `bot/handlers/message.ts:280` 就分来 Meta，永不进 processPipeline
  // （`metaNeedsLegacyPipeline` 只对 `/slash` 和 checkin/stats 两类返 true）。
  //
  // 于是：群主说"开反广告" → `tryAntiAdCommand` 写 Redis 键 ✓（round 3 接过 Meta）
  //       → 读者 `renderAdPressure` 在 Meta 侧、每回合都跑 ✓
  //       → **但没有任何人往账本里写数据** → `[噪声]` 永远是空 → 模型看不到刷屏
  //
  // Redis 实测证据：两个授权群（-1004384664699 / -1003184176508）名下
  // `xxb:trench:antiad:win:*` **一条都没有**；仅有的两条 win 键属于另外两个群
  // （-2790030956 / -2790030690，匿名管理员 uid），是走 legacy 的那 2% 留下的。
  //
  // 所以不是"阈值太高"或"没人刷屏"，是**采集端根本没接上**。
  //
  // round 3 只拆了 `ANTIAD_ENABLED` 那道全局闸（它挡在 legacy 内部），
  // 没解决"legacy 本身不走"——同一个病的两层，我只修了一层。
  if (chatId < 0 && !formatted.isBot) {
    try {
      const e = env();
      const granted = ((e.ANTIAD_CHAT_IDS as number[] | undefined)?.includes(chatId)) ?? false;
      if (granted || await (async () => {
        try {
          const { antiAdEnabled } = await import('../nyatos/ad-pressure.js');
          return await antiAdEnabled(chatId);
        } catch { return false; }
      })()) {
        const { noteInbound } = await import('../nyatos/ad-pressure.js');
        await noteInbound(chatId, formatted.uid ?? 0, text, Math.floor(Date.now() / 1000));
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: antiad noteInbound failed (non-critical)');
    }
  }

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

  // ── 人在纠正/生气 → 群冷却（round 61，新 goal）──
  //
  // 实测（2026-09-23，-1004430867819，0/18 没人接）：
  //   04:49-04:56 bot 连刷 14 条同一件事的变体，而群里的人已经在纠正它：
  //     @hunhebi_bot 再说一次，我的节点没有炸（生气）
  //   人在纠正，它还在刷。这个群 0% 有人接的真相：刷的内容没人想接，
  //   人只在纠正它——"纠正"没被算进 replied/reacted，所以我量成了 0%。
  //
  // 这是**止损**，不是改心流判据（那是操作手册第 3 档、要拍板）。
  // 判据纯文本：冲着 bot 来 + 带纠正/负面词。命中就静默 + 按群冷却 10 分钟。
  // （Meta 侧没有 judgeResult，用 opts.isDirect 合成 addressedRule——
  //   tryCorrectionIntercept 的第三个参数已改成兼容两种形态。）
  //
  // 必须接在 Meta 上：round 54 的教训（react 只接 legacy，生产走 Meta，
  // 于是 9 次 react 全被丢弃）。
  if (chatId < 0 && !formatted.isBot && text.length >= 2) {
    try {
      const { tryCorrectionIntercept } = await import('../pipeline/stages/intercepts.js');
      if (await tryCorrectionIntercept(chatId, formatted, { addressedRule: opts.isDirect ? 'direct' : 'passive' })) return 'handled';
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: correction intercept failed (non-critical)');
    }
  }
  // ── 贴纸差评拦截 ──
  //
  // 2026-09-22 round 8。同 antiad-command 的病：原来只在 legacy 的
  // `pipeline/stages/intercepts.ts:226`（tryPostMuteIntercepts ← post-judge
  // ← processPipeline），而"回复本喵发的贴纸 + 说不喜欢"在 Meta 上是 L0，
  // 永不进 legacy judge。实测 `sticker_dislike` rule 生产 **0 次**、
  // `Sticker dislike recorded` **0 次**。
  //
  // 值得接的原因：模型能 conversational 回"好的不发了"，但它不会调
  // `recordStickerDislike`——那是纯数据动作（贴纸评分下降）。不接的后果是
  // bot 继续用被差评的贴纸，而它以为用户知道它改了。
  //
  // 判据刻意和 legacy 一致：必须**回复本喵发过的贴纸** + 文本命中
  // `looksLikeStickerDislike`。别处不拦。
  if (chatId < 0 && formatted.replyTo && formatted.replyTo.uid === getBotUid() && !formatted.isBot) {
    try {
      const { tryStickerDislikeCommand } = await import('../pipeline/stages/sticker-dislike-command.js');
      if (await tryStickerDislikeCommand(chatId, formatted, getBotUid())) return 'handled';
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: sticker-dislike intercept failed (non-critical)');
    }
  }

  // ── 群主自助开关反广告 ──
  //
  // 2026-09-22 round 3：我上一轮（5131460）把 `tryAntiAdCommand` 加进了
  // **legacy** 的 `pipeline/stages/intercepts.ts:216`——而那正是我同一个 commit
  // 里刚给 `routeLearnedCommand` 修掉的病："功能接在了一条生产不走的路上"。
  // 生产人类消息在 `bot/handlers/message.ts:280` 就分去 Meta，永不进
  // processPipeline。subagent 审计实测：`antiad command` 日志 0 次、
  // `xxb:trench:antiad:*` 0 个群键。
  //
  // 为什么这一条比别的更要命：它是**唯一**能给 `/spam@nmnmfunbot` 授权的地方。
  // `bot-delegation.ts:186-193` 要求 `ANTIAD_KICK_ENABLED || antiAdEnabled(chatId)`
  // 才肯做回复式代罚，而 ANTIAD_KICK_ENABLED 没配（默认 false）。
  // 所以授权键不开，`/spam` 那条链就是死代码——
  // 而开授权键的唯一入口刚才在 legacy 上。
  //
  // 放在 routeLearnedCommand 之后：先处理"借别的 bot 办事"，再处理"改本群设置"。
  if (chatId < 0 && !formatted.isBot) {
    try {
      const { tryAntiAdCommand } = await import('../pipeline/stages/antiad-command.js');
      if (await tryAntiAdCommand(chatId, formatted)) return 'handled';
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta: antiad command failed (non-critical)');
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
