// ────────────────────────────────────────
// Pipeline stage: command & feature intercepts — mute commands, slash/NL
// command dispatch, consent replies, sticker dislike, remember/forget,
// DM relay (extracted from pipeline.ts)
// ────────────────────────────────────────

import type { FormattedMessage, JudgeResult } from "../../shared/types.js";
import { sender, ADDRESSED_RULES } from "../shared.js";
import {
  muteUser,
  unmuteUser,
} from "../../tracking/user-profile.js";
import {
  lookupSentSticker,
  recordStickerDislike,
  getStickerScore,
} from "../../knowledge/sticker/store.js";
import { sendChatAction } from "../../bot/sender/telegram.js";
import { detectDmIntentWithAI } from "../dm-relay/detector.js";
import { handleDmRelay } from "../dm-relay/relay.js";
import { detectConsentReply, setConsent } from "../dm-relay/consent.js";
import { isMaster } from "../../admin/auth.js";
import { env } from "../../env.js";
import { logger } from "../../shared/logger.js";
import { addWatch, removeWatch, listWatches } from "../../tracking/topic-watch.js";
import { applyMoodEvent } from "../../tracking/mood.js";
import { startGame, stopGame } from "../games/manager.js";
import { createGuessNumberGame } from "../games/guess-number.js";

// ── Extracted helper 2: Mute command intercepts ─────────────────────

export async function tryMuteCommandIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  if (formatted.isAnonymous) {
    if (judgeResult.rule === "self_mute_request" || judgeResult.rule === "self_unmute_request") {
      await sender.sendDirect(chatId, "频道身份没法用这个命令喵，用个人身份试试~", formatted.messageId);
      return true;
    }
    return false;
  }

  if (chatId >= 0) return false; // group-only

  const rule = judgeResult.rule;

  // mute/unmute 的关键词拦截已下线 —— 改由 directive.ts(回复前 LLM 指令分类)静默执行。
  // 仅保留 /muteme /unmuteme 显式斜杠命令。

  if (rule === "self_mute_request") {
    muteUser(chatId, formatted.uid, 2);
    applyMoodEvent(chatId, -15, "self_mute_request");
    await sender.sendDirect(chatId, "好的，以后本喵不回复你的消息了喵~（发 /unmuteme 取消）", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User self-muted (level 2)");
    return true;
  }

  if (rule === "self_unmute_request") {
    unmuteUser(chatId, formatted.uid);
    applyMoodEvent(chatId, 5, "self_unmute_request");
    await sender.sendDirect(chatId, "好的，本喵又会回复你的消息了喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User self-unmuted");
    return true;
  }

  return false;
}

// ── Extracted helper 3: Pre-mute-gate intercepts ────────────────────

/**
 * Dispatch a known command (slash or NL-resolved) to its handler.
 * Returns true if it handled the message. Shared by the slash-command path and
 * the natural-language router so both stay in lockstep.
 */
async function dispatchCommand(
  chatId: number,
  formatted: FormattedMessage,
  cmd: string,
  arg: string,
): Promise<boolean> {
  if (cmd === "/watch" && arg && chatId < 0) {
    addWatch(chatId, formatted.uid, arg);
    await sender.sendDirect(chatId, `好的，有人聊到「${arg}」本喵会叫你喵~`, formatted.messageId);
    return true;
  }
  if (cmd === "/unwatch" && arg) {
    const ok = removeWatch(chatId, formatted.uid, arg);
    await sender.sendDirect(chatId, ok ? `已取消追踪「${arg}」喵~` : `没有找到这个追踪喵~`, formatted.messageId);
    return true;
  }
  if (cmd === "/watches") {
    const watches = listWatches(chatId, formatted.uid);
    const reply = watches.length > 0 ? `你的追踪列表：\n${watches.map(w => `- ${w}`).join('\n')}` : '你还没有追踪任何话题喵~';
    await sender.sendDirect(chatId, reply, formatted.messageId);
    return true;
  }
  if (cmd === "/game" && chatId < 0) {
    if (arg === "stop") {
      const msg = stopGame(chatId);
      await sender.sendDirect(chatId, msg ?? "没有进行中的游戏喵~", formatted.messageId);
      return true;
    }
    if (arg === "guess" || arg === "猜数字") {
      const game = createGuessNumberGame();
      const msg = startGame(chatId, game, undefined, (cid, text2) => sender.sendDirect(cid, text2));
      await sender.sendDirect(chatId, `${msg}\n本喵想了一个 1-100 的数字，来猜猜看~`, formatted.messageId);
      return true;
    }
    const { partyGame } = await import("../games/party.js");
    const party = partyGame(arg);
    if (party) { await sender.sendDirect(chatId, party, formatted.messageId); return true; }
    await sender.sendDirect(chatId, "可用游戏：/game guess（猜数字）· tod（真心话）· dare（大冒险）· wyr（二选一）· nhie（我从未）", formatted.messageId);
    return true;
  }

  // Collectible 猫娘 cards — /cards 图鉴 + /wish 换卡 (group only, no economy)
  if (chatId < 0 && (cmd === "/cards" || cmd === "/wish") && !formatted.isAnonymous) {
    const { handleGachaCommand } = await import("../gacha/commands.js");
    const reply = await handleGachaCommand(chatId, formatted.uid, cmd, arg);
    if (reply) { await sender.sendDirect(chatId, reply, formatted.messageId); return true; }
  }

  // /feature — group feature toggles (group only)
  if (cmd === "/feature" && chatId < 0) {
    const { handleFeatureCommand } = await import("../dm-relay/feature-gate.js");
    const isMasterUser = isMaster(formatted.uid, env().MASTER_UID);
    const reply = await handleFeatureCommand(chatId, formatted.uid, arg, isMasterUser);
    await sender.sendDirect(chatId, reply, formatted.messageId);
    return true;
  }

  // /help — list all features
  if (cmd === "/help") {
    const { buildHelpText } = await import("../../bot/handlers/help.js");
    await sender.sendDirect(chatId, buildHelpText(), formatted.messageId);
    return true;
  }

  // /setdefault — set default group for DM features (DM only)
  if (cmd === "/setdefault" && chatId > 0) {
    const { handleDmRelay } = await import("../dm-relay/relay.js");
    const idxArg = arg.trim();
    const idx = idxArg ? parseInt(idxArg, 10) : undefined;
    await handleDmRelay(chatId, formatted, {
      type: "set_default_group",
      groupIndex: idx !== undefined && !isNaN(idx) ? idx : undefined,
    });
    return true;
  }

  return false;
}

export async function tryPreMuteIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  // DM: disable group-only commands (/checkin, /stats)
  if (chatId > 0 && judgeResult.rule === "whitelisted_command") {
    const cmd = (formatted.textContent || "").trim().split(/[\s@]/)[0]?.toLowerCase();
    if (cmd === "/checkin" || cmd === "/stats") {
      await sender.sendDirect(chatId, "签到和统计功能只在群里有效喵~", formatted.messageId);
      return true;
    }
  }

  // Slash commands → dispatch
  if (judgeResult.rule === "whitelisted_command" && !formatted.isAnonymous) {
    const text = (formatted.textContent || "").trim();
    const cmd = text.split(/[\s@]/)[0]?.toLowerCase() ?? "";
    const arg = text.replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
    if (await dispatchCommand(chatId, formatted, cmd, arg)) return true;
  }

  // Natural-language command invocation. DM: any clear intent executes. Group:
  // only when the bot is addressed (mention / reply-to-bot), per the addressing rule.
  if (!formatted.isAnonymous && judgeResult.rule !== "whitelisted_command") {
    const addressed = chatId > 0 || ADDRESSED_RULES.has(judgeResult.rule ?? "");
    if (addressed) {
      const { detectCommandIntent } = await import("../nl-commands.js");
      const intent = detectCommandIntent(formatted.textContent || "");
      if (intent) {
        if (intent.kind === "llm") {
          // /checkin & /stats are group-only and rendered by the reply LLM.
          if (chatId > 0) {
            await sender.sendDirect(chatId, "签到和统计只在群里有效喵~", formatted.messageId);
            return true;
          }
          // Rewrite to the canonical slash so the reply-side data injection fires.
          formatted.textContent = intent.cmd;
        } else if (await dispatchCommand(chatId, formatted, intent.cmd, intent.arg)) {
          return true;
        }
      }
    }
  }

  // Consent reply detection (group, replying to bot's consent question)
  if (chatId < 0 && judgeResult.rule === "reply_to_self" && formatted.replyTo) {
    const consentResult = detectConsentReply(formatted.textContent || "", formatted.replyTo.textSnippet);
    if (consentResult) {
      setConsent(chatId, formatted.uid, consentResult.approved ? "approved" : "denied");
      const ack = consentResult.approved ? "好的，已记录同意~" : "好的，不会转发消息给你~";
      await sender.sendDirect(chatId, ack, formatted.messageId);
      logger.info({ chatId, uid: formatted.uid, approved: consentResult.approved }, "Consent reply processed");
      return true;
    }
  }

  return false;
}

// ── Extracted helper 4: Post-mute-gate intercepts ───────────────────

export async function tryPostMuteIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
  e: ReturnType<typeof env>,
): Promise<boolean> {
  // Sticker dislike interception
  if (judgeResult.rule === "sticker_dislike" && formatted.replyTo) {
    const sent = lookupSentSticker(chatId, formatted.replyTo.messageId);
    if (sent) {
      recordStickerDislike(sent.fileUniqueId, chatId, formatted.uid);
      const score = getStickerScore(sent.fileUniqueId);
      const ack = score <= 0.1
        ? "好的，这个贴纸不会再出现了喵~"
        : "知道了，下次少用这个贴纸~";
      await sender.sendDirect(chatId, ack, formatted.messageId);
      logger.info({ chatId, fileUniqueId: sent.fileUniqueId, newScore: score, userId: formatted.uid }, "Sticker dislike recorded");
      return true;
    }
  }

  // 记住/查看/忘掉偏好的关键词拦截已下线 —— remember/forget 改由 directive.ts
  // (回复前 LLM 指令分类)静默执行 + emoji ack。

  // DM relay intercept (private chat only) — always run AI intent detection
  if (chatId > 0 && judgeResult.rule === "private_chat") {
    const text = formatted.textContent || "";
    if (text.trim()) {
      await sendChatAction(chatId, "typing");
      const intent = await detectDmIntentWithAI(text, e.BOT_USERNAME);
      if (intent.type !== "normal_chat") {
        // Flag to suppress post-action rerun on the same user message
        try {
          const { markIntentHandled } = await import("../dm-relay/post-action.js");
          await markIntentHandled(formatted.uid, text);
        } catch (err) {
          logger.debug({ err }, "markIntentHandled failed (non-critical)");
        }
        try {
          await handleDmRelay(chatId, formatted, intent);
        } catch (err) {
          logger.error({ err, chatId }, "DM relay failed");
          await sender.sendDirect(chatId, "处理失败了喵，稍后再试~", formatted.messageId);
        }
        return true;
      }
    }
  }

  return false;
}
