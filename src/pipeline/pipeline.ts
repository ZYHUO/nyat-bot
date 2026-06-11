// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type { ChatJob, FormattedMessage, JudgeResult, ReplyPath, ReplyTier } from "../shared/types.js";
import { resolveReplyPath, resolveReplyTier } from "../shared/types.js";
import { formatMessage } from "./formatter.js";
import { addMessage, getRecent, addAssistant } from "./context/manager.js";
import { judge, l0Rule } from "./judge/judge.js";
import { processMedia } from "./stages/media.js";
import { retrieveContext } from "./context/retriever.js";
import { generateReply } from "./reply/reply.js";
import { calculateTypingDelay, type SegmenterConfig } from "./reply/segmenter.js";
import { sampleHumanDelay } from "./reply/latency-model.js";
import {
  calculateReadDelay,
  decideAckPrefix,
  decideDeleteResend,
  decideEmojiReply,
  decideThinkingInterjection,
  decideAfterthoughtEdit,
  injectTypo,
  applyJitter,
  DEFAULT_HUMANIZER_CONFIG,
  type HumanizerConfig,
} from "./reply/humanizer.js";
import { applyChatPathPolicy, reflectChatPathPolicy } from "./path-policy.js";
import { sender, TEMP_MUTE_CLEAR_RULES, DIRECT_INTERACTION_RULES, ADDRESSED_RULES } from "./shared.js";
import {
  sendChatAction,
  sendMessage,
  sendSticker,
  deleteMessage,
  editMessage,
  reactToMessage,
} from "../bot/sender/telegram.js";
import { getBotUid } from "../bot/bot.js";
import { recordMessage as recordActivity, getActivitySummary } from "../tracking/activity.js";
import { getBotTracker } from "../tracking/interaction.js";
import { tryGenerateDigest } from "../tracking/bot-digest.js";
import {
  recordReply,
  checkOutcome,
  generateReflection,
} from "../tracking/outcome.js";
import {
  recordUserMessage,
  saveUserPreference,
  getUserPreferences,
  getUserProfilePrompt,
  deleteUserPreference,
  getMuteState,
  muteUser,
  unmuteUser,
} from "../tracking/user-profile.js";
import { memorizeMessage } from "../memory/chroma.js";
import { maybeReact } from "./reactions.js";
import { recordInteraction } from "../tracking/social-graph.js";
import {
  getReadyStickersByIntent,
  recordStickerSent,
  lookupSentSticker,
  recordStickerDislike,
  getStickerScore,
} from "../knowledge/sticker/store.js";
import { loadOverrideCached } from "../admin/runtime-config.js";
import { isMaster } from "../admin/auth.js";
import { getRedis } from "../db/redis.js";
import { callWithFallback } from "../ai/fallback.js";
import { detectDmIntentWithAI } from "./dm-relay/detector.js";
import {
  handleDmRelay,
  handlePendingGroupSelection,
} from "./dm-relay/relay.js";
import {
  getPendingGroupSelection,
  clearPendingGroupSelection,
} from "./dm-relay/group-resolver.js";
import { detectConsentReply, setConsent } from "./dm-relay/consent.js";
import {
  getRemainingMaxQuota,
  consumeMaxQuota,
} from "../tracking/reply-max-quota.js";
import { acquireChatLock } from "../queue/chat-lock.js";
import { AIError } from "../shared/errors.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { parseMuteTimedRequest } from "./judge/rules.js";
import { addWatch, removeWatch, listWatches, checkWatches } from "../tracking/topic-watch.js";
import { recordMessage as recordStatMessage, recordBotReply } from "../tracking/stats.js";
import { recordBotReply as recordTimingBotReply, recordGateNoAction } from "./timing/state-store.js";
import { applyMoodEvent } from "../tracking/mood.js";
import { recordSelfReply } from "../tracking/self-history.js";
import { startGame, playGame, stopGame, hasActiveGame } from "./games/manager.js";
import { createGuessNumberGame } from "./games/guess-number.js";
import { runTimingGate } from "./timing/gate.js";
import {
  transitionToWait,
  transitionToStop,
  transitionToRunning,
  recordGateContinue,
  getChatState,
  isInGateCooldown,
} from "./timing/chat-runtime.js";
import { loadCachedPrompt } from "../shared/config.js";
import { composeSelfState } from "./heart/self-state.js";
import { heartDecision } from "./heart/decision.js";
import { computeEngagement, HARD_PASS_BUDGET } from "./heart/engagement.js";
import { needsLookup } from "./heart/path-heuristic.js";
import { setWaitAnchor } from "./turn/buffer.js";
import { pickRevisitCandidates } from "./turn/answered-store.js";
import { getFocus as getChatFocus } from "./turn/focus.js";
import { getChatStyle, styleSegmenterOverlay, styleHumanizerOverlay, type ChatStyle } from "../tracking/chat-style.js";
import { getLifeState } from "../tracking/life-state.js";

// P2:贴纸冷却/去重 per-chat 化 —— 旧的模块级全局让 A 群发贴纸重置 B 群
// 的冷却(跨群共享状态,行为相互污染)。
const MAX_RECENT_STICKERS = 50;
const STICKER_COOLDOWN_REPLIES = 6;
interface StickerState { ids: Set<string>; queue: string[]; repliesSince: number }
const _stickerStates = new Map<number, StickerState>();
function _stickerState(chatId: number): StickerState {
  let st = _stickerStates.get(chatId);
  if (!st) {
    st = { ids: new Set(), queue: [], repliesSince: STICKER_COOLDOWN_REPLIES };
    _stickerStates.set(chatId, st);
  }
  return st;
}
function _trackRecentSticker(chatId: number, id: string): void {
  const st = _stickerState(chatId);
  st.ids.add(id);
  st.queue.push(id);
  if (st.queue.length > MAX_RECENT_STICKERS) {
    const old = st.queue.shift()!;
    st.ids.delete(old);
  }
  st.repliesSince = 0;
}
/**
 * #9 分钟级延迟改错字:真人常常过几分钟才想起来 edit 一个 typo。
 * 进程内定时器(重启丢失可接受);触发时若中间有人说过话 → "被打断忘了改"。
 */
function scheduleDeferredTypoFix(chatId: number, messageId: number, correctText: string, sentAtSec: number): void {
  const delayMs = (120 + Math.random() * 360) * 1000; // 2–8 分钟
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const recent = await getRecent(chatId, 6);
        const interrupted = recent.some((m) => m.role !== "assistant" && m.timestamp > sentAtSec);
        if (interrupted) return; // 有人说话了,忘了改
        await editMessage(chatId, messageId, correctText);
        logger.debug({ chatId, messageId }, "Deferred typo fix applied");
      } catch { /* non-critical */ }
    })();
  }, delayMs);
  timer.unref?.();
}

function isAssistantTurn(
  message: { role: string; uid: number },
  botUid: number,
): boolean {
  return message.role === "assistant" || message.uid === botUid;
}

async function shouldSuppressStaleReply(
  chatId: number,
  message: { messageId: number; uid: number },
  judgeRule: string | undefined,
  botUid: number,
  recentWindow: number,
): Promise<boolean> {
  if (chatId > 0 || (judgeRule && DIRECT_INTERACTION_RULES.has(judgeRule))) {
    return false;
  }

  const recent = await getRecent(chatId, Math.max(recentWindow, 20));
  const currentIndex = recent.findIndex(
    (entry) =>
      entry.messageId === message.messageId && entry.uid === message.uid,
  );
  if (currentIndex < 0) return false;

  return recent
    .slice(currentIndex + 1)
    .some((entry) => isAssistantTurn(entry, botUid));
}

// ── Extracted helper 2: Mute command intercepts ─────────────────────

async function tryMuteCommandIntercepts(
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

  if (rule === "mute_hard_request") {
    muteUser(chatId, formatted.uid, 2);
    applyMoodEvent(chatId, -20, "mute_hard_request");
    await sender.sendDirect(chatId, "好的，本喵完全闭嘴喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid, level: 2 }, "User hard-muted bot");
    return true;
  }

  if (rule === "mute_soft_request") {
    muteUser(chatId, formatted.uid, 1, { temporary: true });
    applyMoodEvent(chatId, -8, "mute_soft_request");
    await sender.sendDirect(chatId, "好的，本喵不会主动找你说话了喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid, level: 1 }, "User soft-muted bot");
    return true;
  }

  if (rule === "mute_timed_request") {
    const text = formatted.textContent || formatted.captionContent || "";
    const durationMs = parseMuteTimedRequest(text);
    if (durationMs && durationMs > 0) {
      muteUser(chatId, formatted.uid, 1, { temporary: true, durationMs });
      applyMoodEvent(chatId, -8, "mute_timed_request");
      const minutes = Math.round(durationMs / 60_000);
      await sender.sendDirect(chatId, `好的，本喵安静 ${minutes} 分钟喵~`, formatted.messageId);
      logger.info({ chatId, uid: formatted.uid, durationMs }, "User timed-muted bot");
      return true;
    }
    return false;
  }

  if (rule === "unmute_request") {
    unmuteUser(chatId, formatted.uid);
    applyMoodEvent(chatId, 5, "unmute_request");
    await sender.sendDirect(chatId, "嗯！本喵又可以说话啦喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User unmuted bot");
    return true;
  }

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
    const { partyGame } = await import("./games/party.js");
    const party = partyGame(arg);
    if (party) { await sender.sendDirect(chatId, party, formatted.messageId); return true; }
    await sender.sendDirect(chatId, "可用游戏：/game guess（猜数字）· tod（真心话）· dare（大冒险）· wyr（二选一）· nhie（我从未）", formatted.messageId);
    return true;
  }

  // Collectible 猫娘 cards — /cards 图鉴 + /wish 换卡 (group only, no economy)
  if (chatId < 0 && (cmd === "/cards" || cmd === "/wish") && !formatted.isAnonymous) {
    const { handleGachaCommand } = await import("./gacha/commands.js");
    const reply = await handleGachaCommand(chatId, formatted.uid, cmd, arg);
    if (reply) { await sender.sendDirect(chatId, reply, formatted.messageId); return true; }
  }

  // /feature — group feature toggles (group only)
  if (cmd === "/feature" && chatId < 0) {
    const { handleFeatureCommand } = await import("./dm-relay/feature-gate.js");
    const isMasterUser = isMaster(formatted.uid, env().MASTER_UID);
    const reply = await handleFeatureCommand(chatId, formatted.uid, arg, isMasterUser);
    await sender.sendDirect(chatId, reply, formatted.messageId);
    return true;
  }

  // /help — list all features
  if (cmd === "/help") {
    const { buildHelpText } = await import("../bot/handlers/help.js");
    await sender.sendDirect(chatId, buildHelpText(), formatted.messageId);
    return true;
  }

  // /setdefault — set default group for DM features (DM only)
  if (cmd === "/setdefault" && chatId > 0) {
    const { handleDmRelay } = await import("./dm-relay/relay.js");
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

async function tryPreMuteIntercepts(
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
      const { detectCommandIntent } = await import("./nl-commands.js");
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

async function tryPostMuteIntercepts(
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

  // Remember request
  if (judgeResult.rule === "remember_request" && !formatted.isAnonymous) {
    const text = (formatted.textContent || formatted.captionContent || "").trim();
    const content = text
      .replace(/^(?:帮[我俺]?记(?:住|一下|下来?)|记(?:住|下来?)(?:一下)?[：:，,]\s*|keep\s+in\s+mind[：:，,\s]*|记得(?:一下)?[：:，,]\s*)/i, "")
      .trim();
    if (content) {
      try {
        saveUserPreference(chatId, formatted.uid, content);
        logger.info({ chatId, uid: formatted.uid, content }, "User preference saved");
        await sender.sendDirect(chatId, "记住啦喵~", formatted.messageId);
        return true;
      } catch (err) {
        logger.warn({ err, chatId }, "saveUserPreference failed");
      }
    }
  }

  // View preferences request
  if (judgeResult.rule === "view_prefs_request" && !formatted.isAnonymous) {
    const prefs = getUserPreferences(chatId, formatted.uid);
    const profile = getUserProfilePrompt(chatId, formatted.uid);
    const parts: string[] = [];
    if (profile) parts.push(`🧠 本喵对你的印象：\n${profile}`);
    if (prefs) parts.push(`📝 你让本喵记住的：\n${prefs}`);
    const reply = parts.length > 0 ? parts.join('\n\n') : '本喵还没记住什么呢喵~';
    await sender.sendDirect(chatId, reply, formatted.messageId);
    return true;
  }

  // Forget preference request
  if (judgeResult.rule === "forget_request" && !formatted.isAnonymous) {
    const text = (formatted.textContent || "").trim();
    const keyword = text
      .replace(/^(?:忘(?:掉|了|记)?[：:，,\s]*|别记了[：:，,\s]*|不用记了[：:，,\s]*|forget\s*)/i, "")
      .trim();
    if (keyword) {
      const deleted = deleteUserPreference(chatId, formatted.uid, keyword);
      await sender.sendDirect(
        chatId,
        deleted ? `已经忘掉「${deleted}」了喵~` : "没找到相关的记忆喵~",
        formatted.messageId,
      );
      return true;
    }
  }

  // DM relay intercept (private chat only) — always run AI intent detection
  if (chatId > 0 && judgeResult.rule === "private_chat") {
    const text = formatted.textContent || "";
    if (text.trim()) {
      await sendChatAction(chatId, "typing");
      const intent = await detectDmIntentWithAI(text, e.BOT_USERNAME);
      if (intent.type !== "normal_chat") {
        // Flag to suppress post-action rerun on the same user message
        try {
          const { markIntentHandled } = await import("./dm-relay/post-action.js");
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

// ── Extracted helper 5: Reply generation + send ─────────────────────

interface ChatLockState {
  release: () => Promise<void>;
  held: boolean;
}

async function generateAndSendReplies(args: {
  job: ChatJob;
  formatted: FormattedMessage;
  judgeResult: JudgeResult;
  botUid: number;
  effectiveReplyPath: ReplyPath;
  effectiveReplyTier: ReplyTier;
  e: ReturnType<typeof env>;
  start: number;
  timings: Record<string, number>;
  lockState: ChatLockState;
  releaseHeldChatLock: () => Promise<void>;
}): Promise<void> {
  const {
    job, formatted, judgeResult, botUid,
    effectiveReplyPath, effectiveReplyTier,
    e, start, timings, lockState, releaseHeldChatLock,
  } = args;

  // 指令服从层:点名/回复 bot/私聊语境下的自然语言指令 → prompt 强注入 +
  // 禁止沉默 + 关闭 humanizer 内容篡改(指令产物要保真)。
  let instructionInfo: import("./reply/instruction.js").InstructionInfo | null = null;
  try {
    const { detectInstruction } = await import("./reply/instruction.js");
    const addressed =
      job.chatId > 0 || !!(judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule));
    instructionInfo = detectInstruction(formatted, {
      addressed,
      isMasterUser: isMaster(formatted.uid, e.MASTER_UID),
    });
    if (instructionInfo) {
      logger.info(
        { chatId: job.chatId, messageId: formatted.messageId, strength: instructionInfo.strength },
        "Instruction detected — compliance mode",
      );
    }
  } catch (err) {
    logger.debug({ err, chatId: job.chatId }, "detectInstruction failed (non-critical)");
  }

  // ── 迟到回复(重做版):15-40s 慢尾只在"bot 真的离开过"时发生 ──
  // 条件:群聊、actor 回合、非 replan、非指令、**非点名**(@/回复 bot 永远
  // 不迟到),且本群 ≥10 分钟没回过话(期间被点名会回话 → 时钟自动刷新,
  // 即一次迟到/任何回复后 10 分钟内不会再迟到)。
  // 命中后:生成前注入"刚没看到"语气提示,投递时静默等待(不显示 typing),
  // 只在最后 2-3 秒才显示"正在输入"——像刚拿起手机才看到。
  let latenessSec: number | undefined;
  const isDirectForLateness = !!(judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule));
  if (
    job.chatId < 0 && job.turnContext && !job.turnContext.isReplan &&
    !instructionInfo && !isDirectForLateness
  ) {
    try {
      const tstate = await getChatState(job.chatId);
      const idleMs = tstate.lastBotReplyAt ? Date.now() - tstate.lastBotReplyAt : Number.POSITIVE_INFINITY;
      if (idleMs >= 10 * 60_000 && Math.random() < 0.3) {
        latenessSec = 15 + Math.random() * 25;
        logger.info({ chatId: job.chatId, latenessSec: Math.round(latenessSec), idleMin: Math.round(idleMs / 60000) }, "Late-reply mode: bot was away");
      }
    } catch (err) {
      logger.debug({ err, chatId: job.chatId }, "lateness check failed (non-critical)");
    }
  }

  let maxPlaceholderMsgId: number | undefined;
  try {
    // 6. reply_max: quota check + thinking placeholder
    if (effectiveReplyTier === "max") {
      const remaining = getRemainingMaxQuota(formatted.uid);
      if (remaining <= 0) {
        await sender.sendDirect(job.chatId, "今天的深度思考次数已用完喵（每人每天3次）~", formatted.messageId);
        logger.info({ chatId: job.chatId, uid: formatted.uid }, "reply_max quota exhausted");
        return;
      }
      maxPlaceholderMsgId = await sendMessage(job.chatId, "💭 思考中…");
    }

    // 6b. Send typing indicator
    await sendChatAction(job.chatId, "typing");

    // Pre-load runtime override for segmenter config (needed before generateReply)
    const override = await loadOverrideCached(getRedis()).catch(() => null);

    // #6/#11 群风格 underlay:长度镜像 + 标点/emoji 习惯随群漂移。
    // 运营 override > 群风格 > 全局默认。
    let styleSeg: Partial<SegmenterConfig> | undefined;
    let styleHum: Partial<HumanizerConfig> | undefined;
    let chatStyle: ChatStyle | null = null;
    if (job.chatId < 0) {
      try {
        chatStyle = await getChatStyle(job.chatId);
        if (chatStyle) {
          styleSeg = styleSegmenterOverlay(chatStyle);
          styleHum = styleHumanizerOverlay(chatStyle);
        }
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "chat-style fetch failed (non-critical)");
      }
    }

    // P1:部分 override 不得用 undefined 覆盖群风格 underlay(过滤空值)
    const overrideSeg: Partial<SegmenterConfig> | undefined = override?.reply_segmentation
      ? (Object.fromEntries(
          Object.entries({
            enabled: override.reply_segmentation.enabled,
            maxLength: override.reply_segmentation.max_length,
            maxSentenceNum: override.reply_segmentation.max_sentence_num,
            defaultReply: override.reply_segmentation.default_reply,
            typingChineseTime: override.reply_segmentation.typing_chinese_time,
            typingEnglishTime: override.reply_segmentation.typing_english_time,
          }).filter(([, v]) => v !== undefined),
        ) as Partial<SegmenterConfig>)
      : undefined;
    const segmenterConfig: Partial<SegmenterConfig> | undefined =
      styleSeg || overrideSeg ? { ...(styleSeg ?? {}), ...(overrideSeg ?? {}) } : undefined;
    const baseHumanizerConfig: Partial<HumanizerConfig> | undefined = override?.humanizer
      ? Object.fromEntries(
          Object.entries({
            typoEnabled: override.humanizer.typo_enabled,
            typoRate: override.humanizer.typo_rate,
            typoCorrectionRate: override.humanizer.typo_correction_rate,
            readDelayEnabled: override.humanizer.read_delay_enabled,
            readDelayBase: override.humanizer.read_delay_base,
            ackPrefixEnabled: override.humanizer.ack_prefix_enabled,
            deleteResendEnabled: override.humanizer.delete_resend_enabled,
            deleteResendRate: override.humanizer.delete_resend_rate,
            jitterEnabled: override.humanizer.jitter_enabled,
            jitterFactor: override.humanizer.jitter_factor,
            emojiReplyEnabled: override.humanizer.emoji_reply_enabled,
            emojiReplyRate: override.humanizer.emoji_reply_rate,
            emojiReplyMaxLength: override.humanizer.emoji_reply_max_length,
            thinkingInterjectionEnabled: override.humanizer.thinking_interjection_enabled,
            thinkingInterjectionRate: override.humanizer.thinking_interjection_rate,
            thinkingInterjectionMinTotalLength: override.humanizer.thinking_interjection_min_total_length,
            thinkingInterjectionMinSegments: override.humanizer.thinking_interjection_min_segments,
            afterthoughtEditEnabled: override.humanizer.afterthought_edit_enabled,
            afterthoughtEditRate: override.humanizer.afterthought_edit_rate,
            afterthoughtEditDelay: override.humanizer.afterthought_edit_delay,
          }).filter(([, v]) => v !== undefined)
        ) as Partial<HumanizerConfig>
      : undefined;

    // #4 ASI self-tune: per-chat humanizer override (set by asi-scoring when the
    // rolling uncanny-risk EMA crosses thresholds). Shallow-merge over the
    // computed config so dialed-down rates win. Null-safe: no override → unchanged.
    // 合并顺序:群风格 underlay < 运营 override < ASI 自调 per-chat override
    let humanizerConfig: Partial<HumanizerConfig> | undefined =
      styleHum || baseHumanizerConfig ? { ...(styleHum ?? {}), ...(baseHumanizerConfig ?? {}) } : undefined;
    try {
      const chatOverrideRaw = await getRedis().get(`xxb:humanizer:override:${job.chatId}`);
      if (chatOverrideRaw) {
        const chatOverride = JSON.parse(chatOverrideRaw) as Partial<HumanizerConfig>;
        humanizerConfig = { ...(humanizerConfig ?? {}), ...chatOverride };
      }
    } catch (err) {
      logger.debug({ err, chatId: job.chatId }, "Humanizer per-chat override fetch failed (non-critical)");
    }

    // 7. 4-way context retrieval
    const t4 = performance.now();
    const retrievalMode = effectiveReplyPath === "planned" ? "planned" : "direct";
    const retrievedContext = await retrieveContext(job.chatId, formatted, botUid, { mode: retrievalMode });
    timings["retrieval"] = Math.round(performance.now() - t4);

    // 8. Generate reply (interruptible when invoked by the turn actor — G3;
    // burst ids let the model pick the real anchor of the thought — G4;
    // unanswered revisit candidates let it circle back — G7)
    const t5 = performance.now();
    let revisitCandidates;
    if (e.TURN_UNANSWERED_REVISIT_ENABLED && job.turnContext && job.chatId < 0) {
      try {
        const recentForRevisit = await getRecent(job.chatId, 30);
        revisitCandidates = await pickRevisitCandidates(
          job.chatId,
          recentForRevisit,
          [formatted.messageId, ...(job.turnContext.burstMessageIds ?? [])],
          botUid,
        );
        if (revisitCandidates.length === 0) revisitCandidates = undefined;
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "pickRevisitCandidates failed (non-critical)");
      }
    }
    const turnCallOpts = job.turnContext || instructionInfo || latenessSec !== undefined
      ? {
          signal: job.turnContext?.signal,
          burstIds: e.TURN_BURST_JUDGE_ENABLED ? job.turnContext?.burstMessageIds : undefined,
          revisitCandidates,
          actionSpace: job.turnContext ? e.TURN_ACTION_PLANNER_ENABLED : undefined,
          instruction: instructionInfo ?? undefined,
          heartWhy: job.turnContext?.heartWhy,
          latenessHint: latenessSec !== undefined
            ? '[迟到回复] 你刚才没在看这个群(在忙别的),过了好一会儿才看到这条消息。回复**开头**自然带一句迟到的语气("刚没看到""才看到喵"之类),轻描淡写就好,不用正式道歉。'
            : undefined,
        }
      : undefined;
    const genStartMs = Date.now();
    const replyResult = await generateReply(
      formatted, retrievedContext, judgeResult.action,
      job.chatId, botUid, effectiveReplyPath, effectiveReplyTier,
      segmenterConfig,
      turnCallOpts,
    );
    const replies = replyResult.replies;
    timings["reply"] = Math.round(performance.now() - t5);

    // G2: model-chosen emoji reactions execute as first-class acts (with a
    // small human-ish delay so the react doesn't land robotically instantly)。
    // 调度时机:modelSilent 路径立即排(react-only 是合法回应);文本路径
    // 推迟到打断/陈旧检查之后排 —— 否则被丢弃的回复会留下孤儿 reaction。
    const scheduleReactions = (): void => {
      if (!replyResult.reactions || replyResult.reactions.length === 0) return;
      for (const r of replyResult.reactions) {
        setTimeout(() => {
          reactToMessage(job.chatId, r.targetMessageId, r.emoji)
            .then((ok) => {
              if (ok) {
                logger.info({ chatId: job.chatId, targetMessageId: r.targetMessageId, emoji: r.emoji }, "Model-chosen reaction sent");
                // react 也算"回应过了"——别让 G7 回访反复推荐这条
                import("./turn/answered-store.js")
                  .then(({ markAnswered }) => markAnswered(job.chatId, [r.targetMessageId]))
                  .catch(() => {});
              }
            })
            .catch(() => {});
        }, 800 + Math.random() * 1500);
      }
    };

    // G2: deliberate silence — the model looked and chose not to speak.
    if (replyResult.modelSilent && replies.length === 0) {
      scheduleReactions(); // react-only 回应照常落地
      if (maxPlaceholderMsgId) {
        await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
      }
      if (e.TURN_FOCUS_ENABLED && job.chatId < 0) {
        import("./turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'model_silent')).catch(() => {});
      }
      logger.info(
        { chatId: job.chatId, messageId: formatted.messageId, reacted: !!replyResult.reactions },
        "Pipeline complete (model chose silence)",
      );
      return;
    }

    // Re-acquire chat lock before sending
    lockState.release = await acquireChatLock(job.chatId);
    lockState.held = true;

    if (await shouldSuppressStaleReply(job.chatId, formatted, judgeResult.rule, botUid, e.JUDGE_WINDOW_SIZE)) {
      if (maxPlaceholderMsgId) {
        await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
      }
      logger.info(
        { chatId: job.chatId, messageId: formatted.messageId, rule: judgeResult.rule },
        "Concurrent reply suppressed after newer assistant turn",
      );
      return;
    }

    // G3: 投递前最后一道打断检查 — 生成完成与开始发送之间用户又说话了,
    // 整套 humanizer 延迟还没开始,此刻丢弃重规划仍然便宜。
    // (开始发送后不再中止:真人也会把已经在打的那句话发完。)
    if (job.turnContext?.signal?.aborted) {
      if (maxPlaceholderMsgId) {
        await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
      }
      throw new AIError("Turn interrupted before send", "send", "send", "AI_ABORTED");
    }

    // #7 typing ghost:~3% 概率"正在输入…"几秒然后什么都不发——
    // 真人经常打了一半觉得算了。仅限:群聊、非指令、非 direct 交互、
    // 人味预算还在、5 分钟冷却。对 bot 是浪费一次生成,对人味是真实感。
    if (
      job.chatId < 0 &&
      !instructionInfo &&
      process.env['NODE_ENV'] !== 'test' && // 3% 骰子会让测试薛定谔
      !(judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule)) &&
      Math.random() < 0.03
    ) {
      try {
        const ghostKey = `xxb:ghost:${job.chatId}`;
        const set = await getRedis().set(ghostKey, '1', 'EX', 300, 'NX');
        if (set !== null) {
          const ghostSec = 4 + Math.random() * 8;
          logger.info({ chatId: job.chatId, ghostSec: Math.round(ghostSec) }, 'Typing ghost — typed then abandoned');
          await sendChatAction(job.chatId, 'typing');
          if (ghostSec > 5) {
            setTimeout(() => sendChatAction(job.chatId, 'typing').catch(() => {}), 4500);
          }
          await new Promise((r) => setTimeout(r, ghostSec * 1000));
          if (e.TURN_FOCUS_ENABLED) {
            import("./turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'model_silent')).catch(() => {});
          }
          if (maxPlaceholderMsgId) {
            await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
          }
          return; // 打了一半,算了
        }
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, 'typing ghost failed (non-critical)');
      }
    }

    // 文本回复确定要发了(ghost 没触发)→ 此刻才调度伴随的 reactions
    // (P2:ghost 之后才排,否则"打了一半算了"还留下一个孤儿 emoji)
    scheduleReactions();

    // #3 小群降 quote:回复紧跟目标消息、中间没别人插话时,引用是冗余的
    // ——真人只在需要"消歧"时才 quote。概率随本群真人引用率回归;
    // 指向他人消息的跨目标回复保留引用(那正是需要消歧的场景)。
    let suppressLatestQuote = false;
    if (job.chatId < 0 && !instructionInfo) {
      try {
        const recent8 = await getRecent(job.chatId, 8);
        const idx = recent8.findIndex((m) => m.messageId === formatted.messageId);
        // 触发消息必须在窗口内才评估(找不到 → 保守保留引用)
        if (idx >= 0) {
          const interleaved = recent8
            .slice(idx + 1)
            .some((m) => m.uid !== formatted.uid && m.role !== 'assistant' && !m.isBot);
          if (!interleaved) {
            const quoteRatio = chatStyle?.quoteRatio ?? 0.2;
            const suppressProb = 1 - Math.min(0.85, Math.max(0.08, quoteRatio * 2.5));
            suppressLatestQuote = Math.random() < suppressProb;
          }
        }
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, 'quote-policy check failed (non-critical)');
      }
    }

// 9. Send all replies to Telegram
    const t6 = performance.now();
    const sentMessages: Array<{ messageId: number; text: string }> = [];
    // Targets already quote-replied in this burst. A multi-target reply (e.g.
    // [{reply to requester}, {reply to someone else}]) must quote EACH distinct
    // target; only repeat bubbles to an ALREADY-quoted target drop the quote
    // (so segmented replies to the same message don't quote it N times).
    const quotedTargets = new Set<number>();

    // ── Humanizer: read delay ──
    // Note: don't delete placeholder here — let it be edited into the first reply
    // in the send loop. Only delete if no placeholder exists (sentiment was "thinking").
    // Skip for DM — users expect instant response in private chat.

    const incomingLength = formatted.textContent?.length ?? 0;
    const isDmChat = job.chatId > 0;
    // 延迟构成:
    //   - 迟到分支(latenessSec):计划总迟到时长 − 已消耗的生成时间,
    //     剩余部分静默等待 —— "没在看手机的人不会显示正在输入"
    //   - 常规分支:短延迟人类分布采样(慢尾已移到迟到分支,这里不再有 15-40s)
    let readDelay: number;
    if (latenessSec !== undefined) {
      readDelay = Math.max(2.5, latenessSec - (Date.now() - genStartMs) / 1000);
    } else {
      const readDelayBase = isDmChat ? 0 : calculateReadDelay(incomingLength, humanizerConfig);
      readDelay = readDelayBase > 0
        ? sampleHumanDelay(readDelayBase, { capSec: 8, tailProb: 0 })
        : 0;
    }
    if (readDelay > 0) {
      // 只在最后 2-3 秒显示"正在输入"(刚拿起手机才开始打字);
      // 之前的整段 typing 会让 40 秒的"正在输入…"看起来像卡死。
      const typingLead = Math.min(readDelay, 2 + Math.random());
      const silentPart = readDelay - typingLead;
      logger.debug({ chatId: job.chatId, readDelay, silentPart, incomingLength }, 'Humanizer: read delay');
      if (silentPart > 0) {
        await new Promise((resolve) => setTimeout(resolve, silentPart * 1000));
        // 静默期内被打断 → 还没"看到",直接重规划
        if (job.turnContext?.signal?.aborted) {
          throw new AIError("Turn interrupted during read delay", "send", "send", "AI_ABORTED");
        }
      }
      await sendChatAction(job.chatId, 'typing');
      await new Promise((resolve) => setTimeout(resolve, typingLead * 1000));
      if (job.turnContext?.signal?.aborted) {
        throw new AIError("Turn interrupted during read delay", "send", "send", "AI_ABORTED");
      }
    }

    // G10: 每回合"人味预算"(actor 模式)— 确认前缀/typo/撤回重发/后补编辑
    // 一回合最多触发一个,效果像偶发的真实行为而不是抽搐生成器。
    // 指令回复预算清零:让它"原样重复/翻译/报数"时不能被错别字篡改。
    let humanizerBudget = instructionInfo ? 0 : job.turnContext ? 1 : Number.POSITIVE_INFINITY;

    // ── Humanizer: ack prefix(纳入人味预算)──
    const totalReplyLength = replies.reduce((sum, r) => sum + (r.replyContent?.length ?? 0), 0);
    const ackPrefix = humanizerBudget > 0
      ? decideAckPrefix(totalReplyLength, humanizerConfig)
      : { shouldSend: false as const, prefix: null, delay: 0 };
    if (ackPrefix.shouldSend) humanizerBudget--;

    const stickerPolicy = {
      enabled: override?.sticker_policy?.enabled ?? true,
      mode: override?.sticker_policy?.mode ?? "ai",
      sendPosition: override?.sticker_policy?.send_position ?? "after",
    };
    const replyQuoteEnabled = override?.reply_quote !== false;

    // ── Humanizer: thinking interjection (insert between 1st and 2nd segments) ──
    // Skip for DM — users expect instant response in private chat
    const thinkingResult = isDmChat
      ? { shouldInsert: false, text: '' }
      : decideThinkingInterjection(totalReplyLength, replies.length, humanizerConfig);
    if (thinkingResult.shouldInsert && replies.length >= 2) {
      const insertIdx = 1;
      replies.splice(insertIdx, 0, {
        replyContent: thinkingResult.text,
        targetMessageId: replies[0]!.targetMessageId,
        replyQuote: false,
        stickerIntent: [],
        isInterjection: true,
      });
      logger.debug({ chatId: job.chatId, text: thinkingResult.text }, 'Humanizer: thinking interjection inserted');
    }

    for (let replyIdx = 0; replyIdx < replies.length; replyIdx++) {
      const reply = replies[replyIdx]!;

      // ── Humanizer: ack prefix (send before first reply) ──
      // Skip for DM — users expect instant response in private chat.
      // 前缀**不带引用**:真人"嗯"一声只是占位,quote 由正文自己决定 ——
      // 否则同一条消息被"嗯"和正文各 reply 一次,非常机器人。
      if (replyIdx === 0 && !isDmChat && ackPrefix.shouldSend && ackPrefix.prefix) {
        await sendChatAction(job.chatId, 'typing');
        const ackDelay = humanizerConfig?.jitterEnabled !== false
          ? applyJitter(1.0, humanizerConfig?.jitterFactor ?? 0.2)
          : 1.0;
        await new Promise((resolve) => setTimeout(resolve, ackDelay * 1000));
        await sender.sendDirect(job.chatId, ackPrefix.prefix).catch(() => {});
        // Pause between prefix and main content
        await sendChatAction(job.chatId, 'typing');
        await new Promise((resolve) => setTimeout(resolve, (ackPrefix.delay ?? 1.5) * 1000));
      }

      // ── Humanizer: skip humanizer effects for interjection segments ──
      const isInterjection = reply.isInterjection === true;

      // ── Humanizer: typo injection ──
      // Skip for DM — users expect instant, clean response in private chat
      const humanizedText = reply.replyContent;
      const typoResult = humanizerBudget > 0 && !isDmChat && !isInterjection && replyIdx === 0 && humanizedText.length >= 4
        ? (() => { const r = injectTypo(humanizedText, humanizerConfig); return r.typoIndex >= 0 ? r : null; })()
        : null;
      if (typoResult) humanizerBudget--;

      // ── Humanizer: delete-and-resend (skip for interjections and DM) ──
      const deleteResend = isDmChat || isInterjection || humanizerBudget <= 0
        ? { shouldDeleteResend: false, deleteDelay: 0, modifiedText: humanizedText }
        : decideDeleteResend(replyIdx, replies.length, humanizedText, humanizerConfig);
      if (deleteResend.shouldDeleteResend) humanizerBudget--;

      // ── MaiBot-style typing delay between segmented messages ──
      // First message uses the placeholder or sends immediately;
      // subsequent messages simulate human typing rhythm.
      if (replyIdx > 0) {
        const prevText = replies[replyIdx - 1]!.replyContent;
        // #1 段间打字延迟同样走人类分布(段间偶尔停顿想词,但尾巴收紧)
        const delay = sampleHumanDelay(calculateTypingDelay(prevText, segmenterConfig), {
          tailProb: 0.06,
          capSec: 8,
          floorSec: 0.2,
        });
        await sendChatAction(job.chatId, 'typing');
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }

      // ── G10: model-owned hesitation — the model marked THIS line as one it
      // wants to brew on for a beat before sending (emphasis/turning point)
      if (reply.hesitateBefore && !isDmChat) {
        await sendChatAction(job.chatId, 'typing');
        await new Promise((resolve) => setTimeout(resolve, 1200 + Math.random() * 1100));
      }

      try {
        let stickerFileId: string | undefined;
        let stickerFileUniqueId: string | undefined;
        let stickerIntent: string | undefined;
        if (
          stickerPolicy.enabled &&
          stickerPolicy.mode !== "off" &&
          reply.stickerIntent &&
          reply.stickerIntent.length > 0 &&
          // G2: 模型把贴纸当一等动作时跳过冷却(明确意图 > RNG 节流)
          (_stickerState(job.chatId).repliesSince >= STICKER_COOLDOWN_REPLIES || reply.modelStickerAct === true)
        ) {
          const candidates = getReadyStickersByIntent(reply.stickerIntent);
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const fresh = candidates.filter((c) => !_stickerState(job.chatId).ids.has(c.fileUniqueId));
            const pool = (fresh.length > 0 ? fresh : candidates).slice(0, 10);
            const picked = pool[Math.floor(Math.random() * pool.length)]!;
            _trackRecentSticker(job.chatId, picked.fileUniqueId);
            stickerFileId = picked.fileId;
            stickerFileUniqueId = picked.fileUniqueId;
            stickerIntent = reply.stickerIntent[0];
          }
        }

        if (stickerFileId && stickerPolicy.sendPosition === "before") {
          const stickerMsgId = await sendSticker(job.chatId, stickerFileId).catch((err) => {
            logger.warn({ err, chatId: job.chatId }, "Sticker send (before) failed, continuing");
            return undefined;
          });
          if (stickerMsgId && stickerFileUniqueId) {
            recordStickerSent(job.chatId, stickerMsgId, stickerFileUniqueId, stickerFileId, stickerIntent);
          }
        }

        // Quote-reply the target UNLESS this exact target was already quoted in this
        // burst. Segments of one reply share a target → only the first quotes it.
        // A multi-target reply keeps a separate quote per distinct target, so a reply
        // aimed at someone other than the requester actually points at THEM.
        const targetAlreadyQuoted =
          reply.targetMessageId > 0 && quotedTargets.has(reply.targetMessageId);
        const quoteDroppedByPolicy =
          suppressLatestQuote && reply.targetMessageId === formatted.messageId;
        const replyToId =
          !replyQuoteEnabled || reply.replyQuote === false || reply.targetMessageId <= 0 || targetAlreadyQuoted || quoteDroppedByPolicy
            ? undefined
            : reply.targetMessageId;
        // quotedTargets is updated at the actual text-send site below, so sticker-only
        // bubbles don't falsely mark a target as already-quoted.

        const isStickerOnly = reply.replyContent.trim() === '[sticker]' && stickerFileId;

        // If AI wanted to send a sticker-only reply but no matching sticker was found,
        // fall back to an emoji based on stickerIntent instead of sending literal "[sticker]"
        if (reply.replyContent.trim() === '[sticker]' && !stickerFileId) {
          const INTENT_EMOJI: Record<string, string> = {
            happy: '😊', laughing: '😂', giggling: '🤭', grinning: '😄', beaming: '😁',
            cheerful: '😊', joyful: '🥳', excited: '🤩', cute: '🥰', content: '😌',
            sad: '😢', crying: '😭', sobbing: '😭', heartbroken: '💔', gloomy: '😔',
            angry: '😤', rage: '🤬', grumpy: '😾', fuming: '😡',
            surprised: '😲', shocked: '😱', astonished: '🤯', speechless: '😶',
            scared: '😨', terrified: '😱', nervous: '😰', anxious: '😟',
            shy: '😳', embarrassed: '😅', confused: '🤔', bored: '🥱',
            proud: '😤', grateful: '🙏', jealous: '😒', guilty: '😣',
            greeting: '👋', farewell: '👋', thanking: '🙏', apologizing: '🙏',
            encouraging: '💪', congratulating: '🎉', comforting: '🫂', cheering_up: '💪',
            agreeing: '👍', disagreeing: '🙅', facepalm: '🤦', eyeroll: '🙄',
            thumbs_up: '👍', thumbs_down: '👎', clapping: '👏', nodding: '😊',
            love: '❤️', wink: '😉', thinking: '🤔',
            sleepy: '😴', cool: '😎', fire: '🔥',
            roasting: '🔥', flirting: '😏', begging: '🥺', persuading: '🙏',
          };
          const intent = reply.stickerIntent?.[0] ?? '';
          const emoji = INTENT_EMOJI[intent] ?? '😊';
          reply.replyContent = emoji;
          logger.debug({ chatId: job.chatId, stickerIntent: intent, emoji }, 'AI wanted sticker but none found, falling back to emoji');
        }

        // ── Humanizer: sticker-only short reply (skip for interjections) ──
        const stickerOnlyResult = !isInterjection
          ? decideEmojiReply(reply.replyContent.length, humanizerConfig)
          : { shouldReplace: false, intent: '' };
        let stickerOnlyFileId: string | undefined;
        let stickerOnlyFileUniqueId: string | undefined;

        // If sticker-only replacement triggered, try to find a sticker by intent
        if (stickerOnlyResult.shouldReplace && stickerPolicy.enabled && stickerPolicy.mode !== 'off') {
          const stickerCandidates = getReadyStickersByIntent([stickerOnlyResult.intent]);
          if (stickerCandidates.length > 0) {
            stickerCandidates.sort((a, b) => b.score - a.score);
            const fresh = stickerCandidates.filter((c) => !_stickerState(job.chatId).ids.has(c.fileUniqueId));
            const pool = (fresh.length > 0 ? fresh : stickerCandidates).slice(0, 5);
            const picked = pool[Math.floor(Math.random() * pool.length)]!;
            _trackRecentSticker(job.chatId, picked.fileUniqueId);
            stickerOnlyFileId = picked.fileId;
            stickerOnlyFileUniqueId = picked.fileUniqueId;
          }
        }

        // Use typo text if available, otherwise original
        let effectiveText = typoResult ? typoResult.typoedText : reply.replyContent;
        // If sticker-only replacement resolved a sticker, skip text send
        const skipTextSend = stickerOnlyFileId !== undefined && stickerOnlyResult.shouldReplace;

        if (!isStickerOnly && !skipTextSend) {
          if (replyIdx === 0 && maxPlaceholderMsgId) {
            await editMessage(job.chatId, maxPlaceholderMsgId, effectiveText).catch(() => {});
            // ── Humanizer: typo correction (placeholder path) ──
            if (typoResult && typoResult.correction === 'edit') {
              const correctionDelay = humanizerConfig?.typoCorrectionDelay ?? DEFAULT_HUMANIZER_CONFIG.typoCorrectionDelay;
              await sendChatAction(job.chatId, 'typing');
              await new Promise((resolve) => setTimeout(resolve, correctionDelay * 1000));
              await editMessage(job.chatId, maxPlaceholderMsgId, typoResult.originalText).catch(() => {});
              logger.debug({ chatId: job.chatId, original: effectiveText, corrected: typoResult.originalText }, 'Humanizer: typo corrected via edit (placeholder)');
            }
            sentMessages.push({ messageId: maxPlaceholderMsgId, text: typoResult ? typoResult.originalText : effectiveText });
            // ── Humanizer: typo append (placeholder path — send correct char as follow-up) ──
            if (typoResult && typoResult.correction === 'append' && typoResult.correctChar) {
              const appendDelay = humanizerConfig?.typoCorrectionDelay ?? DEFAULT_HUMANIZER_CONFIG.typoCorrectionDelay;
              await sendChatAction(job.chatId, 'typing');
              await new Promise((resolve) => setTimeout(resolve, appendDelay * 1000));
              const appendSent = await sender.sendDirect(job.chatId, typoResult.correctChar);
              if (appendSent.messageId) {
                sentMessages.push({ messageId: appendSent.messageId, text: typoResult.correctChar });
              }
              logger.debug({ chatId: job.chatId, typo: effectiveText, appended: typoResult.correctChar }, 'Humanizer: typo append (placeholder)');
            }
          } else {
            const sent = await sender.sendDirect(job.chatId, effectiveText, replyToId);
            // Mark this target quoted only after a real text reply went out with the quote.
            if (replyToId !== undefined) quotedTargets.add(replyToId);

            // ── Humanizer: delete-and-resend ──
            let currentMessageId: number | undefined = sent.messageId;
            let currentBaseText = typoResult ? typoResult.originalText : effectiveText;
            if (deleteResend.shouldDeleteResend && sent.messageId) {
              await sendChatAction(job.chatId, 'typing');
              await new Promise((resolve) => setTimeout(resolve, deleteResend.deleteDelay * 1000));
              await deleteMessage(job.chatId, sent.messageId).catch(() => {});
              await sendChatAction(job.chatId, 'typing');
              const resendDelay = Math.min(calculateTypingDelay(deleteResend.modifiedText, segmenterConfig), 1.5);
              await new Promise((resolve) => setTimeout(resolve, resendDelay * 1000));
              const resent = await sender.sendDirect(job.chatId, deleteResend.modifiedText, replyToId);
              sentMessages.push({ messageId: resent.messageId, text: deleteResend.modifiedText });
              logger.debug({ chatId: job.chatId, original: effectiveText, modified: deleteResend.modifiedText }, 'Humanizer: delete-and-resend');
              currentMessageId = resent.messageId;
              currentBaseText = deleteResend.modifiedText;
            } else {
              sentMessages.push({ messageId: sent.messageId, text: currentBaseText });
            }

            // ── Humanizer: typo correction via edit ──
            if (typoResult && typoResult.correction === 'edit' && currentMessageId) {
              if (Math.random() < 0.4) {
                // #9 四成概率拖到几分钟后才想起来改(被打断就忘了)
                scheduleDeferredTypoFix(job.chatId, currentMessageId, typoResult.originalText, Math.floor(Date.now() / 1000));
              } else {
                const correctionDelay = humanizerConfig?.typoCorrectionDelay ?? DEFAULT_HUMANIZER_CONFIG.typoCorrectionDelay;
                await sendChatAction(job.chatId, 'typing');
                await new Promise((resolve) => setTimeout(resolve, correctionDelay * 1000));
                await editMessage(job.chatId, currentMessageId, typoResult.originalText).catch(() => {});
                logger.debug({ chatId: job.chatId, original: effectiveText, corrected: typoResult.originalText }, 'Humanizer: typo corrected via edit');
              }
            }

            // ── Humanizer: typo append (send correct char as follow-up) ──
            if (typoResult && typoResult.correction === 'append' && typoResult.correctChar) {
              const appendDelay = humanizerConfig?.typoCorrectionDelay ?? DEFAULT_HUMANIZER_CONFIG.typoCorrectionDelay;
              await sendChatAction(job.chatId, 'typing');
              await new Promise((resolve) => setTimeout(resolve, appendDelay * 1000));
              const appendSent = await sender.sendDirect(job.chatId, typoResult.correctChar);
              if (appendSent.messageId) {
                sentMessages.push({ messageId: appendSent.messageId, text: typoResult.correctChar });
              }
              logger.debug({ chatId: job.chatId, typo: effectiveText, appended: typoResult.correctChar }, 'Humanizer: typo append');
            }

            // ── Humanizer: afterthought edit (skip for interjections and DM) ──
            if (!isDmChat && !isInterjection && currentMessageId && humanizerBudget > 0) {
              const afterthought = decideAfterthoughtEdit(currentBaseText, humanizerConfig);
              if (afterthought.shouldEdit) {
                humanizerBudget--;
                const afterthoughtDelay = humanizerConfig?.afterthoughtEditDelay ?? DEFAULT_HUMANIZER_CONFIG.afterthoughtEditDelay;
                const afterthoughtDelayJittered = humanizerConfig?.jitterEnabled !== false
                  ? applyJitter(afterthoughtDelay, humanizerConfig?.jitterFactor ?? 0.2)
                  : afterthoughtDelay;
                await sendChatAction(job.chatId, 'typing');
                await new Promise((resolve) => setTimeout(resolve, afterthoughtDelayJittered * 1000));
                await editMessage(job.chatId, currentMessageId, afterthought.editedText).catch(() => {});
                logger.debug({ chatId: job.chatId, original: effectiveText, edited: afterthought.editedText }, 'Humanizer: afterthought edit');
              }
            }

            if (stickerFileId && stickerPolicy.sendPosition === "after") {
              const stickerMsgId = await sendSticker(job.chatId, stickerFileId).catch((err) => {
                logger.warn({ err, chatId: job.chatId }, "Sticker send (after) failed, continuing");
                return undefined;
              });
              if (stickerMsgId && stickerFileUniqueId) {
                recordStickerSent(job.chatId, stickerMsgId, stickerFileUniqueId, stickerFileId, stickerIntent);
              }
            }
          }
        } else if (skipTextSend && stickerOnlyFileId) {
          // ── Humanizer: sticker-only short reply (replaces text with sticker) ──
          // Delete placeholder if this was the first reply
          if (replyIdx === 0 && maxPlaceholderMsgId) {
            await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
          }
          const stickerMsgId = await sendSticker(job.chatId, stickerOnlyFileId).catch((err) => {
            logger.warn({ err, chatId: job.chatId }, "Sticker-only reply send failed");
            return undefined;
          });
          if (stickerMsgId && stickerOnlyFileUniqueId) {
            recordStickerSent(job.chatId, stickerMsgId, stickerOnlyFileUniqueId, stickerOnlyFileId, stickerOnlyResult.intent);
          }
          if (stickerMsgId) {
            sentMessages.push({ messageId: stickerMsgId, text: '[sticker]' });
          }
        } else if (stickerFileId) {
          const stickerMsgId = await sendSticker(job.chatId, stickerFileId).catch((err) => {
            logger.warn({ err, chatId: job.chatId }, "Sticker-only send failed");
            return undefined;
          });
          if (stickerMsgId && stickerFileUniqueId) {
            recordStickerSent(job.chatId, stickerMsgId, stickerFileUniqueId, stickerFileId, stickerIntent);
          }
          sentMessages.push({ messageId: stickerMsgId ?? 0, text: '[sticker]' });
        }

        _stickerState(job.chatId).repliesSince++;
        try { recordBotReply(job.chatId); } catch { /* non-critical */ }
        // Persist lastBotReplyAt to timing state (read by proactive-scan); the
        // tracking recordBotReply above does NOT write it, and the timing-gate one
        // is gated off by default.
        void recordTimingBotReply(job.chatId).catch(() => { /* non-critical */ });
      } catch (err) {
        logger.error(
          { chatId: job.chatId, targetMessageId: reply.targetMessageId, err },
          "Failed to send reply in multi-reply sequence",
        );
      }
    }
    timings["send"] = Math.round(performance.now() - t6);

    if (sentMessages.length === 0) {
      if (maxPlaceholderMsgId) await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
      throw new Error("All replies failed to send");
    }

    // Consume max quota only after successful reply
    if (effectiveReplyTier === "max") {
      consumeMaxQuota(formatted.uid);
      logger.info({ chatId: job.chatId, uid: formatted.uid }, "reply_max quota consumed after success");
    }

    await reflectChatPathPolicy({
      chatId: job.chatId,
      message: formatted,
      botUid,
      effectiveReplyPath,
      replyText: sentMessages[0]?.text ?? "",
      toolsUsed: replyResult.toolsUsed,
      toolExecutionFailed: replyResult.toolExecutionFailed,
    }).catch((err) => {
      logger.debug({ err, chatId: job.chatId }, "Path policy reflection failed (non-critical)");
    });

    // Reset the loneliness clock — the bot just spoke in this chat (social-needs)
    if (job.chatId < 0 && sentMessages.length > 0) {
      import("../tracking/social-needs.js")
        .then(({ markBotSpoke }) => markBotSpoke(job.chatId))
        .catch(() => {});
      // G9: speaking raises focus — the bot is now "in" the conversation
      if (e.TURN_FOCUS_ENABLED) {
        import("./turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'bot_spoke')).catch(() => {});
      }
      // L2: 落点入持续内心(立场延续,下一回合别自相矛盾)
      import("./heart/mind.js").then(({ noteStance }) => noteStance(job.chatId, sentMessages[0]?.text ?? '')).catch(() => {});
      // L5: 惦记两段式收尾(review #7):回复确认发出后才核销已注入的旧
      // 惦记(prompt 拼装只 peek 不删,被打断/抑制时问题保留下次再追),
      // **再**记录本次回复的新问句 —— 同一个 key,顺序反了会误删新问句。
      if (!formatted.isBot && !formatted.isAnonymous) {
        const lastSent = sentMessages.at(-1)?.text ?? '';
        import("../tracking/curiosity.js")
          .then(async ({ commitPendingQuestion, noteAskedQuestion }) => {
            await commitPendingQuestion(job.chatId, formatted.uid);
            await noteAskedQuestion(job.chatId, formatted.uid, lastSent);
          })
          .catch(() => {});
      }
    }

    // G6: bounded self-continuation — the bot may follow up its own line a
    // beat later ("对了…"/sticker). Fire-and-forget; yields instantly to any
    // new user message via pending check + abort registry.
    if (
      e.TURN_SELF_FOLLOWUP_ENABLED &&
      job.turnContext &&
      !job.turnContext.isWaitReplay &&
      job.chatId < 0 &&
      sentMessages.length > 0
    ) {
      import("./turn/self-continue.js")
        .then(({ maybeSelfContinue }) => maybeSelfContinue(job.chatId, botUid))
        .catch(() => {});
    }

    // G7: mark every replied-to target (and the trigger itself) as answered
    if (sentMessages.length > 0) {
      const answeredIds = Array.from(new Set([
        formatted.messageId,
        ...replies.map((r) => r.targetMessageId).filter((id) => id > 0),
      ]));
      import("./turn/answered-store.js")
        .then(({ markAnswered }) => markAnswered(job.chatId, answeredIds))
        .catch(() => {});
    }

    // 10. Save ALL sent assistant messages to context (parallel)
    const t7 = performance.now();
    await Promise.all(
      sentMessages.map((sent) =>
        addAssistant(job.chatId, { textContent: sent.text, messageId: sent.messageId }),
      ),
    );
    timings["saveAssistant"] = Math.round(performance.now() - t7);
    await releaseHeldChatLock();

    // 10.5 Post-reply action hook (DM only) — detect if bot promised an action
    if (job.chatId > 0 && sentMessages.length > 0) {
      const userText = formatted.textContent || '';
      const botText = sentMessages.map(s => s.text).join('\n');
      import('./dm-relay/post-action.js').then(({ executePostAction }) => {
        executePostAction(job.chatId, formatted.uid, userText, botText).then((confirmMsg) => {
          if (confirmMsg) {
            sendMessage(job.chatId, confirmMsg).catch((err) => {
              logger.debug({ err }, 'Post-action confirmation send failed');
            });
          }
        }).catch((err) => {
          logger.debug({ err }, 'Post-action hook failed (non-critical)');
        });
      }).catch(() => {});
    }

    // 11. Record reply outcome for FIRST reply (primary)
    if (e.OUTCOME_TRACKING_ENABLED && sentMessages.length > 0) {
      const first = sentMessages[0]!;
      recordReply(
        job.chatId, first.messageId, formatted.messageId,
        formatted.uid, formatted.textContent, first.text, judgeResult.action,
      ).catch((err) => {
        logger.debug({ err, chatId: job.chatId }, "Outcome recording failed (non-critical)");
      });
    }

    // 11.5 Stage F: persist self-reply for self-history retrieval
    // Records every sent reply (not only first) so multi-message replies are captured.
    if (sentMessages.length > 0) {
      for (const sent of sentMessages) {
        try {
          recordSelfReply(job.chatId, formatted.uid, formatted.messageId, sent.text);
        } catch (err) {
          logger.debug({ err, chatId: job.chatId }, "recordSelfReply failed (non-critical)");
        }
      }
    }

    const totalMs = Math.round(performance.now() - start);
    logger.debug(
      {
        chatId: job.chatId, messageId: formatted.messageId,
        action: judgeResult.action, replyPath: effectiveReplyPath,
        replyTier: effectiveReplyTier, retrievalMode,
        recentCount: retrievedContext.recent.length,
        semanticCount: retrievedContext.semantic.length,
        threadCount: retrievedContext.thread.length,
        entityCount: retrievedContext.entity.length,
        retrievalMs: timings["retrieval"] ?? 0,
        replyMs: timings["reply"] ?? 0,
        replyCount: sentMessages.length,
        replyMsgIds: sentMessages.map((s) => s.messageId),
        totalMs, timings,
      },
      "Pipeline complete",
    );
  } catch (err) {
    if (maxPlaceholderMsgId) {
      await deleteMessage(job.chatId, maxPlaceholderMsgId).catch(() => {});
    }

    // Turn interrupt (G3): not a failure — propagate to the actor, which
    // waits the quiet period and replans with the new messages. No fallback
    // message, no error log.
    if (err instanceof AIError && err.code === "AI_ABORTED") {
      logger.info(
        { chatId: job.chatId, messageId: formatted.messageId },
        "Reply generation interrupted by new message, propagating for replan",
      );
      throw err;
    }

    const totalMs = Math.round(performance.now() - start);
    logger.error(
      { chatId: job.chatId, messageId: formatted.messageId, action: judgeResult.action, totalMs, timings, err },
      "Pipeline reply/send failed",
    );

    try {
      await sender.sendDirect(job.chatId, "喵呜...本喵出了点小故障，稍后再试试吧 >_<");
    } catch {
      logger.warn({ chatId: job.chatId }, "Fallback message also failed");
    }
  }
}

// ── Main pipeline orchestrator ──────────────────────────────────────

export async function processPipeline(job: ChatJob): Promise<void> {
  const start = performance.now();
  const timings: Record<string, number> = {};
  const lockState: ChatLockState = {
    release: await acquireChatLock(job.chatId),
    held: true,
  };

  const releaseHeldChatLock = async (): Promise<void> => {
    if (!lockState.held) return;
    lockState.held = false;
    await lockState.release();
  };

  try {
    // 1. Format message
    const t0 = performance.now();
    const formatted = formatMessage(job.update);
    if (!formatted) {
      logger.debug({ chatId: job.chatId }, "Skipping non-formattable update");
      return;
    }

    // Skip bot's own messages — prevents self-reply loops
    if (formatted.uid === getBotUid()) {
      logger.debug({ chatId: job.chatId, messageId: formatted.messageId }, "Skipping own message");
      return;
    }
    timings["format"] = Math.round(performance.now() - t0);

    // 1.5 Channel source ingestion — store and return, no reply
    const channelSourceIds = env().CHANNEL_SOURCE_IDS;
    if (channelSourceIds.length > 0 && channelSourceIds.includes(job.chatId)) {
      const text = formatted.textContent || formatted.captionContent || "";
      if (text.trim()) {
        memorizeMessage(job.chatId, formatted).catch((err) => {
          logger.debug({ err, chatId: job.chatId }, "Channel source memory write failed");
        });
        logger.debug(
          { chatId: job.chatId, messageId: formatted.messageId, len: text.length },
          "Channel source ingested",
        );
      }
      return;
    }

    // 2. Media stage — vision / sticker / multimodal / replyTo attachments
    const tmedia = performance.now();
    await processMedia(formatted);
    if (formatted.imageFileId || formatted.sticker || formatted.audioFileId ||
        formatted.voiceFileId || formatted.documentFileId || formatted.videoFileId ||
        formatted.videoNoteFileId) {
      timings["media"] = Math.round(performance.now() - tmedia);
    }

    const e = env();
    const botUid = getBotUid();
    // G5: wait-resume replay — the anchor entry already went through every
    // bookkeeping stage on first processing; skip context-save + tracking
    // side-effects and go straight to judge→reply.
    const isWaitReplay = job.turnContext?.isWaitReplay === true;

    if (!isWaitReplay) {
    // 3. Save to context
    const t2 = performance.now();
    await addMessage(job.chatId, formatted);
    timings["save"] = Math.round(performance.now() - t2);

    // 3.1 Long-term memory write (fire-and-forget)
    memorizeMessage(job.chatId, formatted).catch((err) => {
      logger.debug({ err, chatId: job.chatId }, "Memory write failed (non-critical)");
    });

    // 3.1b Capture person aliases / 外号 from group messages (deterministic, sync, cheap)
    if (job.chatId < 0 && !formatted.isBot) {
      import("../knowledge/person-aliases.js")
        .then(({ captureAliases }) => captureAliases(job.chatId, formatted))
        .catch((err) => logger.debug({ err, chatId: job.chatId }, "captureAliases failed (non-critical)"));
    }

    // 3.1c Social graph — track member↔member reply ties (sync, cheap)
    if (job.chatId < 0 && !formatted.isBot && formatted.replyTo) {
      const r = formatted.replyTo;
      if (r.uid && r.uid !== formatted.uid && r.uid !== getBotUid()) {
        try { recordInteraction(job.chatId, formatted.uid, formatted.fullName, r.uid, r.fullName); }
        catch { /* non-critical */ }
      }
    }

    // 3.1d Emoji reaction — rare "the cat noticed" signal (≤2/day per chat, group only).
    // G2: action planner 启用后由模型主动选择 react,关闭这个正则 RNG 旁路。
    if (job.chatId < 0 && !formatted.isBot && !formatted.isAnonymous && !env().TURN_ACTION_PLANNER_ENABLED) {
      void maybeReact(job.chatId, formatted.messageId, formatted.textContent || formatted.captionContent || "");
    }

    // 3.34 First-DM onboarding (fire-and-forget) — once per user, then continue
    if (job.chatId > 0 && !formatted.isBot) {
      const redis = getRedis();
      const onboardKey = `xxb:dm:onboarded:${formatted.uid}`;
      redis.set(onboardKey, '1', 'NX').then(async (set) => {
        if (set === null) return; // already onboarded
        const { buildOnboardingText } = await import('../bot/handlers/help.js');
        await sender.sendDirect(job.chatId, buildOnboardingText(), formatted.messageId).catch(() => {});
      }).catch((err) => logger.debug({ err }, 'Onboarding check failed (non-critical)'));
    }

    // 3.35 DM pending confide intercept (before judge, DM only) —
    // when user said "树洞" earlier and we asked for content, treat the next
    // DM message as that content and dispatch via doConfide.
    if (job.chatId > 0) {
      const { hasPendingConfide, clearPendingConfide, doConfide } = await import('./dm-relay/handlers/confide.js');
      if (await hasPendingConfide(formatted.uid)) {
        const text = (formatted.textContent || "").trim();
        if (text) {
          await clearPendingConfide(formatted.uid);
          const { resolveGroup } = await import('./dm-relay/group-resolver.js');
          const result = await resolveGroup(formatted.uid);
          if (result.ok) {
            try {
              await doConfide(
                { uid: formatted.uid, chatId: job.chatId, messageId: formatted.messageId },
                sender,
                text,
                result.group.chatId,
              );
            } catch (err) {
              logger.error({ err, chatId: job.chatId }, "Pending confide handler failed");
              await sender.sendDirect(job.chatId, "处理失败了喵，稍后再试~", formatted.messageId);
            }
          } else if (result.reason === 'multiple_groups') {
            const { savePendingGroupSelection } = await import('./dm-relay/group-resolver.js');
            await savePendingGroupSelection(formatted.uid, {
              intent: 'confide',
              groups: result.groups,
              content: text,
            });
            await sender.sendDirect(job.chatId, result.reply, formatted.messageId);
          } else {
            await sender.sendDirect(job.chatId, result.reply, formatted.messageId);
          }
          return;
        }
      }
    }

    // 3.4 DM pending group selection intercept (before judge, DM only)
    if (job.chatId > 0) {
      const trimmedText = (formatted.textContent || "").trim();
      const num = parseInt(trimmedText, 10);
      if (!isNaN(num) && num > 0 && trimmedText === String(num)) {
        const pending = await getPendingGroupSelection(formatted.uid);
        if (pending && num <= pending.groups.length) {
          const selectedGroup = pending.groups[num - 1]!;
          logger.info({ uid: formatted.uid, selectedGroup: selectedGroup.title, intent: pending.intent }, "Pending group selection resolved");
          try {
            await handlePendingGroupSelection(job.chatId, formatted, selectedGroup, pending.intent, pending.targetHandle, pending.content);
          } catch (err) {
            logger.error({ err, chatId: job.chatId }, "Pending group selection handler failed");
            await sender.sendDirect(job.chatId, "处理失败了喵，稍后再试~", formatted.messageId);
          }
          // Clear AFTER handler completes (handlers may re-read state)
          await clearPendingGroupSelection(formatted.uid);
          return;
        }
      }
    }

    // 3.41 DM verification intercept (before judge, DM only)
    if (job.chatId > 0) {
      const redis = getRedis();
      const verifyActive = await redis.get(`xxb:verify:active:${formatted.uid}`);
      if (verifyActive) {
        await sender.sendDirect(
          job.chatId,
          "🔐 你正在进行入群验证，请先回答验证问题。验证完成后才能继续对话喵~",
          formatted.messageId,
        );
        return;
      }
    }

    // 3.5 Record group activity
    recordActivity(job.chatId, formatted.messageId, formatted.uid).catch((err) => {
      logger.debug({ err, chatId: job.chatId }, "Activity tracking failed (non-critical)");
    });

    // 3.51 Stats (fire-and-forget)
    if (!formatted.isBot) {
      try { recordStatMessage(job.chatId, formatted.uid); } catch (err) { logger.debug({ err, chatId: job.chatId }, 'recordStatMessage failed'); }
    }

    // 3.52 Topic watch notifications (fire-and-forget)
    if (job.chatId < 0 && !formatted.isBot && formatted.textContent) {
      try {
        const watchers = checkWatches(job.chatId, formatted.textContent, formatted.uid);
        for (const uid of watchers) {
          sendMessage(uid, `📢 有人聊到了你追踪的话题喵~`).catch(() => {});
        }
      } catch (err) { logger.debug({ err, chatId: job.chatId }, 'Topic watch check failed'); }
    }

    // 3.53 Relay queue on_speak trigger (fire-and-forget)
    if (job.chatId < 0 && !formatted.isBot && formatted.uid) {
      try {
        const { getPendingRelayForTarget, deliverRelay, setRelayStatus } = await import('./dm-relay/relay-queue.js');
        const { recheckDeliverySafety } = await import('./dm-relay/safety.js');
        const pendingRelays = getPendingRelayForTarget(formatted.uid, job.chatId);
        for (const relay of pendingRelays) {
          try {
            // Atomic: only deliver if still pending (prevents duplicate delivery)
            const delivered = deliverRelay(relay.id);
            if (!delivered) continue;
            // Re-check safety: sender may have been banned or left the group during the hold
            if (!(await recheckDeliverySafety(relay.sender_id, job.chatId))) {
              setRelayStatus(relay.id, 'cancelled');
              logger.info({ relayId: relay.id, senderUid: relay.sender_id }, 'On-speak relay dropped: sender no longer eligible');
              continue;
            }
            const relayText = `${formatted.fullName}，有人让本喵转告你：${relay.content}`;
            await sendMessage(job.chatId, relayText);
            // Notify sender
            try {
              await sendMessage(relay.sender_id, `✅ 你的捎话已送达 ${formatted.fullName} 喵~`);
            } catch { /* sender may have blocked bot */ }
            logger.info({ relayId: relay.id, targetUid: formatted.uid, groupChatId: job.chatId }, 'On-speak relay delivered');
          } catch (err) {
            logger.error({ err, relayId: relay.id }, 'Failed to deliver on-speak relay');
          }
        }
      } catch (err) { logger.debug({ err, chatId: job.chatId }, 'Relay on_speak check failed'); }
    }

    // 3.54 Profile notification hook (fire-and-forget)
    if (job.chatId < 0 && !formatted.isBot && formatted.uid) {
      try {
        const { checkProfileNotifications } = await import('./dm-relay/handlers/profile.js');
        await checkProfileNotifications(job.chatId, formatted);
      } catch (err) { logger.debug({ err, chatId: job.chatId }, 'Profile notification check failed'); }
    }

    // 3.6 Bot interaction tracking
    if (formatted.isBot && formatted.username) {
      try {
        getBotTracker()?.recordInteraction(job.chatId, {
          ts: formatted.timestamp, type: "message", bot: formatted.username,
          uid: formatted.uid, text: formatted.textContent, mid: formatted.messageId,
        });
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "Bot interaction tracking failed (non-critical)");
      }
      tryGenerateDigest(job.chatId, formatted.username).catch((err) => {
        logger.debug({ err, chatId: job.chatId }, "Bot digest generation failed (non-critical)");
      });
    }

    // 3.7 Check reply outcomes + trigger self-reflection
    if (e.OUTCOME_TRACKING_ENABLED) {
      checkOutcome(job.chatId, formatted, e.BOT_USERNAME).then(({ needsReflection }) => {
        if (needsReflection) {
          generateReflection(job.chatId, async (prompt) => {
            try {
              const result = await callWithFallback({
                usage: "summarize", messages: [{ role: "user", content: prompt }],
                maxTokens: 300, temperature: 0.3,
              });
              return result.content;
            } catch (err) {
              logger.warn({ err, chatId: job.chatId }, "Reflection AI call failed");
              return null;
            }
          }).catch((err) => {
            logger.debug({ err, chatId: job.chatId }, "generateReflection failed (non-critical)");
          });
        }
      }).catch((err) => {
        logger.debug({ err, chatId: job.chatId }, "Outcome check failed (non-critical)");
      });
    }

    // 3.8 Record user message for profile (fire-and-forget, humans only)
    if (!formatted.isBot && !formatted.isAnonymous && formatted.textContent.trim()) {
      try {
        recordUserMessage(job.chatId, formatted.uid, formatted.username, formatted.fullName, formatted.senderTag, formatted.textContent);
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "User profile record failed (non-critical)");
      }
    }

    // 3.9 Game input interception (before judge — reply to bot with number during active game)
    if (job.chatId < 0 && hasActiveGame(job.chatId) && !formatted.isBot && formatted.replyTo?.uid === getBotUid()) {
      const gameResult = playGame(job.chatId, formatted.uid, formatted.textContent || "");
      if (gameResult) {
        await sender.sendDirect(job.chatId, gameResult, formatted.messageId);
        return;
      }
    }
    } // end !isWaitReplay bookkeeping block (G5)

    // 3.95 Phase 1/4: tracking-only paths skip judge/reply.
    //   - coalesce.isLastInBatch=false → debounce batch non-final message
    //   - skipReply=true              → chat in STOP/WAIT, this message is
    //                                   not a wake-up, just bookkeeping
    if (
      (job.coalesce && !job.coalesce.isLastInBatch) ||
      job.skipReply
    ) {
      const totalMs = Math.round(performance.now() - start);
      logger.debug(
        {
          chatId: job.chatId,
          messageId: formatted.messageId,
          batchSize: job.coalesce?.batchSize,
          skipReply: job.skipReply,
          totalMs,
        },
        "Pipeline complete (tracking only — judge skipped)",
      );
      return;
    }

    // Release lock before judge — judge is the expensive part (LLM call with
    // retries/timeouts). Holding the lock here blocks all other messages for
    // this chat. The lock will be re-acquired before sending (line ~559).
    await releaseHeldChatLock();

    // 4. Judge (L0 → L1 → L2)
    const t3 = performance.now();
    const recentMessages = await getRecent(job.chatId, e.JUDGE_WINDOW_SIZE);

    // 群速不能只从窗口数:recentMessages 被 JUDGE_WINDOW_SIZE(30)截断,
    // 高速群里 hot_chat ≥40/≥60 和参与预算的 firehose 阈值永远够不到
    // (review #9/#12 velocity 死分支)。activity zset 是未截断的真实计数;
    // 取 max 兜底(zset 失败时 getActivitySummary 内部吞错返回 0)。
    const now = Math.floor(Date.now() / 1000);
    let messagesLast5Min = recentMessages.filter((m) => m.timestamp >= now - 300).length;
    let messagesLast1Hour = recentMessages.filter((m) => m.timestamp >= now - 3600).length;
    try {
      const act = await getActivitySummary(job.chatId);
      messagesLast5Min = Math.max(messagesLast5Min, act.messages5min);
      messagesLast1Hour = Math.max(messagesLast1Hour, act.messages1hour);
    } catch { /* fail-soft: 窗口近似 */ }

    // G4: burst-aware judging — when the turn actor drained a multi-message
    // burst, tell the judge to treat the whole burst as one thought.
    const burstIds = e.TURN_BURST_JUDGE_ENABLED ? (job.turnContext?.burstMessageIds ?? []) : [];
    const burstHint = burstIds.length > 1
      ? `[连发提示] 最新的 ${burstIds.length} 条消息（${burstIds.map((id) => `#${id}`).join('、')}）是同一波连发，很可能是一个完整的念头分几条打出来的。请把整波作为一个整体来判断（回不回、值不值得回），不要只盯最后一条——重点经常在前面几条里。`
      : undefined;

    // G9: per-chat focus level modulates the judge's REPLY acceptance bar
    let focusLevel: number | undefined;
    if (e.TURN_FOCUS_ENABLED && job.turnContext && job.chatId < 0) {
      try {
        focusLevel = await getChatFocus(job.chatId);
        // #5/#12: 精力低(深夜/犯懒)时注意力打折 → judge 更倾向沉默
        focusLevel = focusLevel * Math.max(0.5, getLifeState().energy + 0.15);
      } catch { /* non-critical */ }
    }

    // G3: 重规划不重新审判"说不说" —— bot 已经决定要回了,打断只改变
    // "说什么"(MaiBot: 打断后跳过 gate 直接回 planner)。否则锚点换成
    // 用户那句简短补充后,judge 单看它会 IGNORE → 本该有的回复凭空消失。
    // 模型仍可用 {"action":"silent"} 反悔,所以这不是强制说话。
    let judgeResult: JudgeResult;
    if (job.turnContext?.isReplan || job.turnContext?.isWaitReplay) {
      // 用 L0 规则(0ms,无 LLM)恢复锚点的自然 rule:拦截器(mute 命令/
      // NL 命令/remember/DM relay 等)按 rule 分发,全用 'turn_replan' 会
      // 让它们失配。engagement 仍然强制 REPLY(除非 L0 明确 REJECT)。
      const l0 = l0Rule({
        message: formatted, recentMessages, botUid,
        botUsername: e.BOT_USERNAME, botNicknames: e.BOT_NICKNAMES,
        chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
      });
      if (l0?.action === "REJECT") {
        logger.info({ chatId: job.chatId, rule: l0.rule }, "Replan anchor REJECTED by L0, dropping");
        return;
      }
      judgeResult = {
        action: "REPLY",
        level: "L0_RULE",
        rule: l0?.action === "REPLY" && l0.rule ? l0.rule : "turn_replan",
        replyPath: l0?.action === "REPLY" ? l0.replyPath : undefined,
        replyTier: l0?.action === "REPLY" ? l0.replyTier : undefined,
        confidence: 1,
        latencyMs: 0,
      };
      logger.info(
        { chatId: job.chatId, messageId: formatted.messageId, recoveredRule: judgeResult.rule },
        "Replan: engagement carried over, judge skipped",
      );
    } else if (e.HEART_ENABLED && job.chatId < 0 && job.turnContext) {
      // ── 心流路径(S13/G8):一颗心代替三个过滤器 ──
      // L0 规则先跑(0ms 快路:@/回复bot/命令/mute/游戏等确定性场景)。
      // 未命中 → 一次带人格+自我状态的心流判断,直接给出 reply/wait/pass
      // (它就是 gate,后面的 gate 块对 heart 路径跳过)。
      const l0Raw = l0Rule({
        message: formatted, recentMessages, botUid,
        botUsername: e.BOT_USERNAME, botNicknames: e.BOT_NICKNAMES,
        chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
      });
      // "对话热度"类 L0 规则(bot 刚说过话 → 骰子自动 REPLY)在心流模式
      // 下**降级为建议**:它们曾绕过心流和刷屏闸形成自激循环(bot 说一句
      // → 后续消息命中跟进规则 → 自动回 → 永远"刚说过话" → 69 次回复里
      // 只有 12 次经过心流)。被点名(@/回复 bot/命令)仍然直通。
      const CONVERSATIONAL_L0 = new Set(["followup_to_bot", "active_conv_engage"]);
      // hot_chat 骰子同样降级:P2 用确定性的参与预算(velocity 因子)替代 RNG
      const demoteReply = l0Raw && l0Raw.action === "REPLY" && CONVERSATIONAL_L0.has(l0Raw.rule ?? "");
      const demoteIgnore = l0Raw && l0Raw.action === "IGNORE" && l0Raw.rule === "hot_chat";
      const l0 = demoteReply || demoteIgnore ? null : l0Raw;
      if (l0) {
        judgeResult = l0;
      } else if (await isInGateCooldown(job.chatId)) {
        // 冷却短路:刚 pass/wait 过(15s 内)→ 不再为每条消息烧一次心流调用
        logger.debug({ chatId: job.chatId }, "Heart skipped (cooldown), pass");
        return;
      } else {
        // P2 参与预算:占比/速率/群速/精力 合成一个 0..1 标量。
        // 硬阈以下确定性 pass(不烧心流调用);中间带给心流一句体感注记。
        const engagement = computeEngagement(recentMessages, botUid, messagesLast5Min);
        if (engagement.budget <= HARD_PASS_BUDGET) {
          await recordGateNoAction(job.chatId).catch(() => {});
          logger.info(
            { chatId: job.chatId, budget: engagement.budget.toFixed(2), factors: engagement.factors },
            "Heart skipped (engagement budget), pass",
          );
          return;
        }
        const selfState = await composeSelfState(job.chatId);
        let lastSpokeSecAgo: number | undefined;
        try {
          const ts = await getChatState(job.chatId);
          if (ts.lastBotReplyAt) lastSpokeSecAgo = (Date.now() - ts.lastBotReplyAt) / 1000;
        } catch { /* non-critical */ }
        const heartBurstIds = job.turnContext.burstMessageIds ?? [];
        const heart = await heartDecision({
          chatId: job.chatId,
          message: formatted,
          recentMessages,
          botUid,
          // 显示名而非 @handle:"你是hunhebi_bot"和下面 persona 的"我是啾咪囝"打架
          botName: e.BOT_NICKNAMES[0] || e.BOT_USERNAME,
          selfState,
          lastSpokeSecAgo,
          burstNote: [
            heartBurstIds.length > 1
              ? `(★ 是一波 ${heartBurstIds.length} 条连发的末尾,把整波当一个完整念头来评估)`
              : undefined,
            engagement.note ?? undefined,
          ].filter(Boolean).join('\n') || undefined,
          signal: job.turnContext.signal,
        });
        // L2:念头入持续内心(reply/pass/wait 都是念头,沉默也是思考)
        import("./heart/mind.js").then(({ noteThought }) => noteThought(job.chatId, heart.why)).catch(() => {});
        if (heart.act === 'wait') {
          // 心流说"等TA说完" —— 复用 wait 基建(锚点暂存 + 真回访)
          const waitSec = Math.max(e.TIMING_WAIT_MIN_SEC, 8);
          if (e.TURN_WAIT_RESUME_ENABLED) {
            try {
              await setWaitAnchor(job.chatId, {
                update: job.update, chatId: job.chatId,
                messageId: formatted.messageId, enqueuedAt: job.enqueuedAt, waitReplay: true,
              }, waitSec + 120);
            } catch { /* non-critical */ }
          }
          await transitionToWait(job.chatId, waitSec, formatted.messageId);
          logger.info({ chatId: job.chatId, why: heart.why }, "Pipeline complete (heart=wait)");
          return;
        }
        if (heart.act === 'pass') {
          if (e.TURN_FOCUS_ENABLED) {
            import("./turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'gate_no_action')).catch(() => {});
          }
          await recordGateNoAction(job.chatId).catch(() => {});
          logger.info({ chatId: job.chatId, why: heart.why }, "Pipeline complete (heart=pass, still present)");
          return;
        }
        judgeResult = heart.judgeResult;
        job.turnContext.gateBypass = true; // 心流就是 gate,别再问一遍
        job.turnContext.heartWhy = heart.why; // L1:写手顺着同一个念头开笔
      }
    } else {
      judgeResult = await judge({
        message: formatted, recentMessages,
        recentMessagesL2Fetcher: () => getRecent(job.chatId, e.JUDGE_WINDOW_SIZE * 3),
        botUid, botUsername: e.BOT_USERNAME, botNicknames: e.BOT_NICKNAMES,
        chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
        burstHint,
        focus: focusLevel,
      });
    }
    timings["judge"] = Math.round(performance.now() - t3);

    // If L0 returned REPLY without a replyPath, resolve direct vs planned.
    // 心流模式:确定性关键词启发式(0ms)——@/回复bot/私聊这些最高频
    // 交互不再为"要不要用工具"多打一次 LLM。误判代价温和:planned 的
    // planner 自己会再判 needTools。legacy 模式保留 microJudge 原行为。
    if (judgeResult.action === "REPLY" && judgeResult.replyPath === undefined && judgeResult.level === "L0_RULE") {
      if (e.HEART_ENABLED) {
        judgeResult.replyPath = needsLookup(formatted.textContent || formatted.captionContent || "")
          ? "planned"
          : "direct";
      } else {
        const { microJudge } = await import("./judge/micro.js");
        const pathResult = await microJudge(
          formatted, recentMessages, botUid, "judge", "", job.chatId,
          job.turnContext?.signal, burstHint,
        );
        if (pathResult.replyPath) judgeResult.replyPath = pathResult.replyPath;
        if (pathResult.replyTier) judgeResult.replyTier = pathResult.replyTier;
      }
    }

    const rawReplyPath = resolveReplyPath(judgeResult.action, judgeResult.replyPath);
    const effectiveReplyTier = resolveReplyTier(judgeResult.action, judgeResult.replyTier);
    const pathPolicyDecision =
      judgeResult.action === "REPLY" && rawReplyPath
        ? await applyChatPathPolicy({ chatId: job.chatId, message: formatted, botUid, rawReplyPath })
        : { replyPath: rawReplyPath ?? "direct", matchedPatterns: [], source: "raw" as const };
    const effectiveReplyPath = pathPolicyDecision.replyPath;
    const replyTierForReply = effectiveReplyTier ?? "normal";

    logger.debug(
      {
        chatId: job.chatId, messageId: formatted.messageId,
        from: formatted.username || formatted.fullName,
        action: judgeResult.action, rawReplyPath, replyPath: effectiveReplyPath,
        replyTier: replyTierForReply, pathPolicySource: pathPolicyDecision.source,
        pathPolicyPatterns: pathPolicyDecision.matchedPatterns,
        level: judgeResult.level, rule: judgeResult.rule,
        confidence: judgeResult.confidence, judgeMs: judgeResult.latencyMs,
      },
      `Judge: ${judgeResult.action}`,
    );

    // 5. If IGNORE/REJECT → return
    if (judgeResult.action === "IGNORE" || judgeResult.action === "REJECT") {
      const totalMs = Math.round(performance.now() - start);
      logger.debug({ chatId: job.chatId, totalMs, timings }, "Pipeline complete (no reply)");
      return;
    }

    let muteState = !formatted.isAnonymous
      ? getMuteState(job.chatId, formatted.uid)
      : { level: 0 as const, temporary: false };

    if (!formatted.isAnonymous && job.chatId < 0 && muteState.temporary && TEMP_MUTE_CLEAR_RULES.has(judgeResult.rule ?? "")) {
      unmuteUser(job.chatId, formatted.uid);
      muteState = { level: 0, temporary: false };
      logger.info({ chatId: job.chatId, uid: formatted.uid, rule: judgeResult.rule }, "Temporary mute cleared by direct interaction");
    }

    // 5.4 Mute / unmute / self-mute commands
    if (await tryMuteCommandIntercepts(job.chatId, formatted, judgeResult)) {
      return;
    }

    // 5.42 Pre-mute-gate intercepts (DM command guard, watch/game, consent reply)
    if (await tryPreMuteIntercepts(job.chatId, formatted, judgeResult)) {
      return;
    }

    // 5.45 Mute gate
    if (!formatted.isAnonymous) {
      if (muteState.level === 2) {
        logger.debug({ chatId: job.chatId, uid: formatted.uid }, "Pipeline: user hard-muted bot, skipping reply");
        return;
      }
      if (
        muteState.level === 1 &&
        judgeResult.rule !== "reply_to_self" &&
        judgeResult.rule !== "mention_self" &&
        judgeResult.rule !== "whitelisted_command" &&
        judgeResult.rule !== "turn_replan" && // replan 的 engagement 接力自直接交互
        !judgeResult.rule?.includes("lookup")
      ) {
        logger.debug({ chatId: job.chatId, uid: formatted.uid }, "Pipeline: user soft-muted bot, skipping proactive reply");
        return;
      }
    }

    // 5.46 Phase 3: Timing Gate — LLM-based rhythm control
    // Runs only when TIMING_GATE_ENABLED. Direct interactions, max-tier
    // replies, and cooldown all short-circuit to 'continue' inside runTimingGate().
    // Turn-actor replans bypass the gate entirely (MaiBot: post-interrupt
    // replan skips the timing gate and goes straight back to the planner).
    if (e.TIMING_GATE_ENABLED && !job.turnContext?.gateBypass) {
      const isDirect = !!(
        judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule)
      );
      const tg = performance.now();
      let botPersona = '';
      try { botPersona = loadCachedPrompt('identity/persona.md'); } catch { /* non-fatal */ }
      // 在场感:bot 上次发言距今(供 gate 抗"中途蒸发")
      let lastSpokeSecAgo: number | undefined;
      try {
        const ts = await getChatState(job.chatId);
        if (ts.lastBotReplyAt) lastSpokeSecAgo = (Date.now() - ts.lastBotReplyAt) / 1000;
      } catch { /* non-critical */ }
      const gateDecision = await runTimingGate({
        chatId: job.chatId,
        message: formatted,
        recentMessages,
        judgeResult,
        botUid,
        botName: e.BOT_NICKNAMES[0] || e.BOT_USERNAME,
        botPersona,
        isDirectInteraction: isDirect,
        signal: job.turnContext?.signal,
        lastSpokeSecAgo,
      });
      timings["timing_gate"] = Math.round(performance.now() - tg);

      // G3: 打断发生在 gate 推理期间 → 不要基于陈旧状态提交 WAIT/STOP,
      // 上抛给 actor 带新消息重规划(replan 时 gateBypass)。
      if (job.turnContext?.signal?.aborted) {
        throw new AIError("Turn interrupted during gate", "gate", "gate", "AI_ABORTED");
      }

      if (gateDecision.action === 'wait') {
        if (e.TURN_FOCUS_ENABLED && job.chatId < 0) {
          import("./turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'gate_wait')).catch(() => {});
        }
        const waitSecBounded = gateDecision.waitSec ?? e.TIMING_WAIT_MIN_SEC;
        // G5: actor 模式暂存锚点条目,wait 到期后重注入 pending 真正回访
        // (而不是只解除屏蔽然后永远沉默)。
        if (e.TURN_WAIT_RESUME_ENABLED && job.turnContext) {
          try {
            await setWaitAnchor(
              job.chatId,
              {
                update: job.update,
                chatId: job.chatId,
                messageId: formatted.messageId,
                enqueuedAt: job.enqueuedAt,
                waitReplay: true,
              },
              waitSecBounded + 120,
            );
          } catch (err) {
            logger.warn({ err, chatId: job.chatId }, "setWaitAnchor failed (wait will be silence-only)");
          }
        }
        await transitionToWait(
          job.chatId,
          waitSecBounded,
          formatted.messageId,
        );
        const totalMs = Math.round(performance.now() - start);
        logger.info(
          { chatId: job.chatId, totalMs, waitSec: gateDecision.waitSec, reason: gateDecision.reason, timings },
          "Pipeline complete (gate=wait, no reply)",
        );
        return;
      }

      if (gateDecision.action === 'no_action') {
        // 冷却期延后:这条不回,但保持 RUNNING(不锁死整个 chat)
        if (gateDecision.deferOnly) {
          const totalMs = Math.round(performance.now() - start);
          logger.info(
            { chatId: job.chatId, totalMs, reason: gateDecision.reason, timings },
            "Pipeline complete (gate cooldown defer, no reply)",
          );
          return;
        }
        if (e.TURN_FOCUS_ENABLED && job.chatId < 0) {
          import("./turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'gate_no_action')).catch(() => {});
        }
        // actor 模式:no_action = 这条不接,但**人还在场**(只记冷却,不 STOP)。
        // 旧 enterStop 会把 chat 锁死到被 @ 才醒 → "说几下就跑了"。
        if (job.turnContext) {
          await recordGateNoAction(job.chatId).catch(() => {});
        } else {
          await transitionToStop(job.chatId);
        }
        const totalMs = Math.round(performance.now() - start);
        logger.info(
          { chatId: job.chatId, totalMs, reason: gateDecision.reason, timings },
          "Pipeline complete (gate=no_action, no reply)",
        );
        return;
      }

      // continue → record + transition (no-op if already RUNNING) and fall through
      await recordGateContinue(job.chatId);
      await transitionToRunning(job.chatId);
    }

    // 5.5-5.7 Post-mute-gate intercepts
    if (await tryPostMuteIntercepts(job.chatId, formatted, judgeResult, e)) {
      return;
    }

    await releaseHeldChatLock();

    // 6-11: Reply generation, send, and post-send bookkeeping
    await generateAndSendReplies({
      job, formatted, judgeResult, botUid,
      effectiveReplyPath, effectiveReplyTier: replyTierForReply,
      e, start, timings, lockState, releaseHeldChatLock,
    });
  } finally {
    await releaseHeldChatLock();
  }
}
