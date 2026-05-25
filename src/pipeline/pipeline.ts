// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type { ChatJob, FormattedMessage, JudgeResult, ReplyPath, ReplyTier } from "../shared/types.js";
import { resolveReplyPath, resolveReplyTier } from "../shared/types.js";
import { formatMessage } from "./formatter.js";
import { addMessage, getRecent, addAssistant } from "./context/manager.js";
import { judge } from "./judge/judge.js";
import { describeImage, describeStickerCached } from "./vision.js";
import { retrieveContext } from "./context/retriever.js";
import { generateReply } from "./reply/reply.js";
import { calculateTypingDelay, type SegmenterConfig } from "./reply/segmenter.js";
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
  type PartialHumanizerConfig,
} from "./reply/humanizer.js";
import { applyChatPathPolicy, reflectChatPathPolicy } from "./path-policy.js";
import { StreamingSender } from "../bot/sender/streaming.js";
import {
  sendChatAction,
  sendMessage,
  sendSticker,
  deleteMessage,
  editMessage,
} from "../bot/sender/telegram.js";
import { getBotUid } from "../bot/bot.js";
import { recordMessage as recordActivity } from "../tracking/activity.js";
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
import {
  getReadyStickersByIntent,
  recordStickerSent,
  lookupSentSticker,
  recordStickerDislike,
  getStickerScore,
} from "../knowledge/sticker/store.js";
import { loadOverrideCached } from "../admin/runtime-config.js";
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
import { describeMultimodal } from "./multimodal.js";
import { acquireChatLock } from "../queue/chat-lock.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { parseMuteTimedRequest } from "./judge/rules.js";
import { addWatch, removeWatch, listWatches, checkWatches } from "../tracking/topic-watch.js";
import { recordMessage as recordStatMessage, recordBotReply } from "../tracking/stats.js";
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
} from "./timing/chat-runtime.js";
import { loadCachedPrompt } from "../shared/config.js";

const sender = new StreamingSender();
const _recentStickerIds = new Set<string>();
const _recentStickerQueue: string[] = [];
const MAX_RECENT_STICKERS = 50;
let _repliesSinceLastSticker = 0;
const STICKER_COOLDOWN_REPLIES = 6;
function _trackRecentSticker(id: string): void {
  _recentStickerIds.add(id);
  _recentStickerQueue.push(id);
  if (_recentStickerQueue.length > MAX_RECENT_STICKERS) {
    const old = _recentStickerQueue.shift()!;
    _recentStickerIds.delete(old);
  }
  _repliesSinceLastSticker = 0;
}
const TEMP_MUTE_CLEAR_RULES = new Set([
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  "mention_self",
  "mention_self_lookup",
]);

const DIRECT_INTERACTION_RULES = new Set([
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  "mention_self",
  "mention_self_lookup",
  "whitelisted_command",
  "private_chat",
]);

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

// ── Extracted helper 1: Media processing ────────────────────────────

async function processMedia(formatted: FormattedMessage): Promise<void> {
  const hasMedia = !!(
    formatted.imageFileId ||
    formatted.sticker ||
    formatted.audioFileId ||
    formatted.voiceFileId ||
    formatted.documentFileId ||
    formatted.videoFileId ||
    formatted.videoNoteFileId
  );
  if (hasMedia) {
    await Promise.all([
      formatted.imageFileId
        ? describeImage(formatted.imageFileId)
            .then((d) => { if (d) formatted.imageDescriptions = [d]; })
            .catch((err) => logger.warn({ err }, "Vision failed, continuing"))
        : Promise.resolve(),
      formatted.sticker
        ? describeStickerCached(formatted.sticker.fileId, formatted.sticker.fileUniqueId)
            .then((d) => { if (d && d !== "[图片]") (formatted.sticker as { description?: string }).description = d; })
            .catch((err) => logger.warn({ err }, "Sticker description failed, continuing"))
        : Promise.resolve(),
      (formatted.audioFileId || formatted.voiceFileId || formatted.documentFileId || formatted.videoFileId || formatted.videoNoteFileId)
        ? describeMultimodal(formatted)
            .then((d) => { if (d) formatted.textContent = (formatted.textContent ? formatted.textContent + "\n" + d : d).trim(); })
            .catch((err) => logger.warn({ err }, "Multimodal processing failed, continuing"))
        : Promise.resolve(),
    ]);
  }

  // ReplyTo attachment — if user replies to a message with a file/image, process it
  if (formatted.replyTo && !formatted.documentFileId && !formatted.imageFileId) {
    if (formatted.replyTo.documentFileId) {
      formatted.documentFileId = formatted.replyTo.documentFileId;
      formatted.documentMimeType = formatted.replyTo.documentMimeType;
      formatted.documentFileName = formatted.replyTo.documentFileName;
      try {
        const desc = await describeMultimodal(formatted);
        if (desc) {
          formatted.textContent = (formatted.textContent ? formatted.textContent + "\n" + desc : desc).trim();
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo document processing failed, continuing");
      }
      formatted.documentFileId = undefined;
    } else if (formatted.replyTo.imageFileId) {
      try {
        const description = await describeImage(formatted.replyTo.imageFileId);
        if (description) {
          formatted.imageDescriptions = [description];
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo image processing failed, continuing");
      }
    }
  }
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

  // Watch/Unwatch/Watches/Game commands
  if (judgeResult.rule === "whitelisted_command" && !formatted.isAnonymous) {
    const text = (formatted.textContent || "").trim();
    const cmd = text.split(/[\s@]/)[0]?.toLowerCase();
    const arg = text.replace(/^\/\w+(?:@\w+)?\s*/, "").trim();

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
      await sender.sendDirect(chatId, "可用游戏：/game guess（猜数字）", formatted.messageId);
      return true;
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

  // DM relay intercept (private chat only)
  if (chatId > 0 && judgeResult.rule === "private_chat") {
    const text = formatted.textContent || "";
    const maybeRelay = /群|看看|瞅瞅|瞄|告诉|传话|转告|转达|发给|传给|带话|送给|转发|@/.test(text);
    if (maybeRelay) {
      await sendChatAction(chatId, "typing");
      const intent = await detectDmIntentWithAI(text, e.BOT_USERNAME);
      if (intent.type !== "normal_chat") {
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
    const segmenterConfig: Partial<SegmenterConfig> | undefined = override?.reply_segmentation
      ? {
          enabled: override.reply_segmentation.enabled,
          maxLength: override.reply_segmentation.max_length,
          maxSentenceNum: override.reply_segmentation.max_sentence_num,
          defaultReply: override.reply_segmentation.default_reply,
          typingChineseTime: override.reply_segmentation.typing_chinese_time,
          typingEnglishTime: override.reply_segmentation.typing_english_time,
        }
      : undefined;
    const humanizerConfig: Partial<HumanizerConfig> | undefined = override?.humanizer
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

    // 7. 4-way context retrieval
    const t4 = performance.now();
    const retrievalMode = effectiveReplyPath === "planned" ? "planned" : "direct";
    const retrievedContext = await retrieveContext(job.chatId, formatted, botUid, { mode: retrievalMode });
    timings["retrieval"] = Math.round(performance.now() - t4);

    // 8. Generate reply
    const t5 = performance.now();
    const replyResult = await generateReply(
      formatted, retrievedContext, judgeResult.action,
      job.chatId, botUid, effectiveReplyPath, effectiveReplyTier,
      segmenterConfig,
    );
    const replies = replyResult.replies;
    timings["reply"] = Math.round(performance.now() - t5);

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

// 9. Send all replies to Telegram
    const t6 = performance.now();
    const sentMessages: Array<{ messageId: number; text: string }> = [];

    // ── Humanizer: read delay ──
    // Note: don't delete placeholder here — let it be edited into the first reply
    // in the send loop. Only delete if no placeholder exists (sentiment was "thinking").

    const incomingLength = formatted.textContent?.length ?? 0;
    const readDelay = calculateReadDelay(incomingLength, humanizerConfig);
    if (readDelay > 0) {
      // Show typing during read delay so user sees bot is "processing"
      await sendChatAction(job.chatId, 'typing');
      // Re-fire typing if delay > 5s (Telegram indicator expires after 5s)
      const reFireTimer = readDelay > 5 ? setTimeout(() => sendChatAction(job.chatId, 'typing').catch(() => {}), 4500) : null;
      logger.debug({ chatId: job.chatId, readDelay, incomingLength }, 'Humanizer: read delay');
      await new Promise((resolve) => setTimeout(resolve, readDelay * 1000));
      if (reFireTimer) clearTimeout(reFireTimer);
    }

    // ── Humanizer: ack prefix ──
    const totalReplyLength = replies.reduce((sum, r) => sum + (r.replyContent?.length ?? 0), 0);
    const ackPrefix = decideAckPrefix(totalReplyLength, humanizerConfig);

    const stickerPolicy = {
      enabled: override?.sticker_policy?.enabled ?? true,
      mode: override?.sticker_policy?.mode ?? "ai",
      sendPosition: override?.sticker_policy?.send_position ?? "after",
    };
    const replyQuoteEnabled = override?.reply_quote !== false;

    const allSameTarget =
      replies.length > 1 &&
      replies.every((r) => r.targetMessageId === replies[0]!.targetMessageId);

    // ── Humanizer: thinking interjection (insert between 1st and 2nd segments) ──
    const thinkingResult = decideThinkingInterjection(totalReplyLength, replies.length, humanizerConfig);
    if (thinkingResult.shouldInsert && replies.length >= 2) {
      const insertIdx = 1;
      replies.splice(insertIdx, 0, {
        replyContent: thinkingResult.text,
        targetMessageId: replies[0]!.targetMessageId,
        replyQuote: false,
        stickerIntent: [],
      });
      logger.debug({ chatId: job.chatId, text: thinkingResult.text }, 'Humanizer: thinking interjection inserted');
    }

    for (let replyIdx = 0; replyIdx < replies.length; replyIdx++) {
      const reply = replies[replyIdx]!;

      // ── Humanizer: ack prefix (send before first reply) ──
      if (replyIdx === 0 && ackPrefix.shouldSend && ackPrefix.prefix) {
        await sendChatAction(job.chatId, 'typing');
        const ackDelay = humanizerConfig?.jitterEnabled !== false
          ? applyJitter(1.0, humanizerConfig?.jitterFactor ?? 0.2)
          : 1.0;
        await new Promise((resolve) => setTimeout(resolve, ackDelay * 1000));
        await sender.sendDirect(job.chatId, ackPrefix.prefix, reply.targetMessageId).catch(() => {});
        // Pause between prefix and main content
        await sendChatAction(job.chatId, 'typing');
        await new Promise((resolve) => setTimeout(resolve, (ackPrefix.delay ?? 1.5) * 1000));
      }

      // ── Humanizer: typo injection ──
      const humanizedText = reply.replyContent;
      const typoResult = replyIdx === 0 && humanizedText.length >= 4
        ? (() => { const r = injectTypo(humanizedText, humanizerConfig); return r.typoIndex >= 0 ? r : null; })()
        : null;

      // ── Humanizer: delete-and-resend ──
      const deleteResend = decideDeleteResend(replyIdx, replies.length, humanizedText, humanizerConfig);

      // ── MaiBot-style typing delay between segmented messages ──
      // First message uses the placeholder or sends immediately;
      // subsequent messages simulate human typing rhythm.
      if (replyIdx > 0) {
        const prevText = replies[replyIdx - 1]!.replyContent;
        const delay = calculateTypingDelay(prevText, segmenterConfig);
        await sendChatAction(job.chatId, 'typing');
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
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
          _repliesSinceLastSticker >= STICKER_COOLDOWN_REPLIES
        ) {
          const candidates = getReadyStickersByIntent(reply.stickerIntent);
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const fresh = candidates.filter((c) => !_recentStickerIds.has(c.fileUniqueId));
            const pool = (fresh.length > 0 ? fresh : candidates).slice(0, 10);
            const picked = pool[Math.floor(Math.random() * pool.length)]!;
            _trackRecentSticker(picked.fileUniqueId);
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

        const replyToId =
          !replyQuoteEnabled || reply.replyQuote === false || (allSameTarget && replyIdx > 0)
            ? undefined
            : reply.targetMessageId;

        const isStickerOnly = reply.replyContent.trim() === '[sticker]' && stickerFileId;

        // ── Humanizer: emoji-only short reply ──
        const emojiResult = decideEmojiReply(reply.replyContent.length, humanizerConfig);
        let emojiSkipSticker = false;
        let emojiReplyToId: number | undefined = replyToId;

        // Use typo text if available, otherwise original (or emoji if replacing)
        let effectiveText: string;
        if (emojiResult.shouldReplace) {
          effectiveText = emojiResult.emoji;
          emojiSkipSticker = true;
          emojiReplyToId = undefined; // emoji-only messages don't quote-reply
        } else {
          effectiveText = typoResult ? typoResult.typoedText : reply.replyContent;
        }

        // If emoji replaced this message, skip sticker
        if (emojiSkipSticker) {
          stickerFileId = undefined;
          stickerFileUniqueId = undefined;
        }

        if (!isStickerOnly) {
          if (replyIdx === 0 && maxPlaceholderMsgId) {
            await editMessage(job.chatId, maxPlaceholderMsgId, effectiveText).catch(() => {});
            // ── Humanizer: typo correction via edit (placeholder path) ──
            if (typoResult && typoResult.correction) {
              const correctionDelay = humanizerConfig?.typoCorrectionDelay ?? DEFAULT_HUMANIZER_CONFIG.typoCorrectionDelay;
              await sendChatAction(job.chatId, 'typing');
              await new Promise((resolve) => setTimeout(resolve, correctionDelay * 1000));
              await editMessage(job.chatId, maxPlaceholderMsgId, typoResult.originalText).catch(() => {});
              logger.debug({ chatId: job.chatId, original: effectiveText, corrected: typoResult.originalText }, 'Humanizer: typo corrected via edit (placeholder)');
            }
            sentMessages.push({ messageId: maxPlaceholderMsgId, text: typoResult ? typoResult.originalText : effectiveText });
          } else {
            const sent = await sender.sendDirect(job.chatId, effectiveText, emojiReplyToId);

            // ── Humanizer: delete-and-resend ──
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
            } else {
              sentMessages.push({ messageId: sent.messageId, text: typoResult ? typoResult.originalText : effectiveText });
            }

            // ── Humanizer: typo correction via edit ──
            if (typoResult && typoResult.correction && sent.messageId) {
              const correctionDelay = humanizerConfig?.typoCorrectionDelay ?? DEFAULT_HUMANIZER_CONFIG.typoCorrectionDelay;
              await sendChatAction(job.chatId, 'typing');
              await new Promise((resolve) => setTimeout(resolve, correctionDelay * 1000));
              // Edit the typoed message to show the correct version (simulates human "fix typo" behavior)
              await editMessage(job.chatId, sent.messageId, typoResult.originalText).catch(() => {
                // Edit might fail (message too old, no perms, etc.) — that's fine
              });
              logger.debug({ chatId: job.chatId, original: effectiveText, corrected: typoResult.originalText }, 'Humanizer: typo corrected via edit');
            }

            // ── Humanizer: afterthought edit (casual minor tweak after sending) ──
            if (!emojiResult.shouldReplace && sent.messageId) {
              const afterthought = decideAfterthoughtEdit(effectiveText, humanizerConfig);
              if (afterthought.shouldEdit) {
                const afterthoughtDelay = humanizerConfig?.afterthoughtEditDelay ?? DEFAULT_HUMANIZER_CONFIG.afterthoughtEditDelay;
                const afterthoughtDelayJittered = humanizerConfig?.jitterEnabled !== false
                  ? applyJitter(afterthoughtDelay, humanizerConfig?.jitterFactor ?? 0.2)
                  : afterthoughtDelay;
                await sendChatAction(job.chatId, 'typing');
                await new Promise((resolve) => setTimeout(resolve, afterthoughtDelayJittered * 1000));
                await editMessage(job.chatId, sent.messageId, afterthought.editedText).catch(() => {});
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

        _repliesSinceLastSticker++;
        try { recordBotReply(job.chatId); } catch { /* non-critical */ }
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

    // 10. Save ALL sent assistant messages to context (parallel)
    const t7 = performance.now();
    await Promise.all(
      sentMessages.map((sent) =>
        addAssistant(job.chatId, { textContent: sent.text, messageId: sent.messageId }),
      ),
    );
    timings["saveAssistant"] = Math.round(performance.now() - t7);
    await releaseHeldChatLock();

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

    // 3. Save to context
    const t2 = performance.now();
    await addMessage(job.chatId, formatted);
    timings["save"] = Math.round(performance.now() - t2);

    // 3.1 Long-term memory write (fire-and-forget)
    memorizeMessage(job.chatId, formatted).catch((err) => {
      logger.debug({ err, chatId: job.chatId }, "Memory write failed (non-critical)");
    });

    const e = env();
    const botUid = getBotUid();

    // 3.4 DM pending group selection intercept (before judge, DM only)
    if (job.chatId > 0) {
      const trimmedText = (formatted.textContent || "").trim();
      const num = parseInt(trimmedText, 10);
      if (!isNaN(num) && num > 0 && trimmedText === String(num)) {
        const pending = await getPendingGroupSelection(formatted.uid);
        if (pending && num <= pending.groups.length) {
          await clearPendingGroupSelection(formatted.uid);
          const selectedGroup = pending.groups[num - 1]!;
          logger.info({ uid: formatted.uid, selectedGroup: selectedGroup.title, intent: pending.intent }, "Pending group selection resolved");
          try {
            await handlePendingGroupSelection(job.chatId, formatted, selectedGroup, pending.intent, pending.targetHandle, pending.content);
          } catch (err) {
            logger.error({ err, chatId: job.chatId }, "Pending group selection handler failed");
            await sender.sendDirect(job.chatId, "处理失败了喵，稍后再试~", formatted.messageId);
          }
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

    // 4. Judge (L0 → L1 → L2)
    const t3 = performance.now();
    const recentMessages = await getRecent(job.chatId, e.JUDGE_WINDOW_SIZE);

    const now = Math.floor(Date.now() / 1000);
    const messagesLast5Min = recentMessages.filter((m) => m.timestamp >= now - 300).length;
    const messagesLast1Hour = recentMessages.filter((m) => m.timestamp >= now - 3600).length;

    const judgeResult = await judge({
      message: formatted, recentMessages,
      recentMessagesL2Fetcher: () => getRecent(job.chatId, e.JUDGE_WINDOW_SIZE * 3),
      botUid, botUsername: e.BOT_USERNAME, botNicknames: e.BOT_NICKNAMES,
      chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
    });
    timings["judge"] = Math.round(performance.now() - t3);

    // If L0 returned REPLY without a replyPath, ask L1 micro judge
    if (judgeResult.action === "REPLY" && judgeResult.replyPath === undefined && judgeResult.level === "L0_RULE") {
      const { microJudge } = await import("./judge/micro.js");
      const pathResult = await microJudge(formatted, recentMessages, botUid, "judge", "", job.chatId);
      if (pathResult.replyPath) judgeResult.replyPath = pathResult.replyPath;
      if (pathResult.replyTier) judgeResult.replyTier = pathResult.replyTier;
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
        !judgeResult.rule?.includes("lookup")
      ) {
        logger.debug({ chatId: job.chatId, uid: formatted.uid }, "Pipeline: user soft-muted bot, skipping proactive reply");
        return;
      }
    }

    // 5.46 Phase 3: Timing Gate — LLM-based rhythm control
    // Runs only when TIMING_GATE_ENABLED. Direct interactions, max-tier
    // replies, and cooldown all short-circuit to 'continue' inside runTimingGate().
    if (e.TIMING_GATE_ENABLED) {
      const isDirect = !!(
        judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule)
      );
      const tg = performance.now();
      let botPersona = '';
      try { botPersona = loadCachedPrompt('identity/persona.md'); } catch { /* non-fatal */ }
      const gateDecision = await runTimingGate({
        chatId: job.chatId,
        message: formatted,
        recentMessages,
        judgeResult,
        botUid,
        botName: e.BOT_USERNAME,
        botPersona,
        isDirectInteraction: isDirect,
      });
      timings["timing_gate"] = Math.round(performance.now() - tg);

      if (gateDecision.action === 'wait') {
        await transitionToWait(
          job.chatId,
          gateDecision.waitSec ?? e.TIMING_WAIT_MIN_SEC,
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
        await transitionToStop(job.chatId);
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
