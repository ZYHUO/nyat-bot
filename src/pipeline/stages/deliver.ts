// ────────────────────────────────────────
// Pipeline stage: reply generation + delivery — humanizer effects,
// sticker selection (with per-chat cooldown state), send loop, and
// post-send bookkeeping (extracted from pipeline.ts)
// ────────────────────────────────────────

import type { ChatJob, FormattedMessage, JudgeResult, ReplyPath, ReplyTier } from "../../shared/types.js";
import { getRecent, addAssistant } from "../context/manager.js";
import { retrieveContext } from "../context/retriever.js";
import { generateReply } from "../reply/reply.js";
import { calculateTypingDelay, type SegmenterConfig } from "../reply/segmenter.js";
import { sampleHumanDelay } from "../reply/latency-model.js";
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
} from "../reply/humanizer.js";
import { reflectChatPathPolicy } from "../path-policy.js";
import { sender, DIRECT_INTERACTION_RULES } from "../shared.js";
import { scheduleDeferredTypoFix, shouldSuppressStaleReply } from "./stale-reply.js";
import {
  sendChatAction,
  sendMessage,
  sendSticker,
  deleteMessage,
  editMessage,
  reactToMessage,
} from "../../bot/sender/telegram.js";
import { recordReply } from "../../tracking/outcome.js";
import {
  getReadyStickersByIntent,
  recordStickerSent,
} from "../../knowledge/sticker/store.js";
import { loadOverrideCached } from "../../admin/runtime-config.js";
import { isMaster } from "../../admin/auth.js";
import { getRedis } from "../../db/redis.js";
import {
  getRemainingMaxQuota,
  consumeMaxQuota,
} from "../../tracking/reply-max-quota.js";
import { acquireChatLock } from "../../queue/chat-lock.js";
import { AIError } from "../../shared/errors.js";
import { env } from "../../env.js";
import { logger } from "../../shared/logger.js";
import { recordBotReply } from "../../tracking/stats.js";
import { recordBotReply as recordTimingBotReply } from "../timing/state-store.js";
import { recordSelfReply } from "../../tracking/self-history.js";
import { getChatState } from "../timing/chat-runtime.js";
import { pickRevisitCandidates } from "../turn/answered-store.js";
import { getChatStyle, styleSegmenterOverlay, styleHumanizerOverlay, type ChatStyle } from "../../tracking/chat-style.js";

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

// ── Extracted helper 5: Reply generation + send ─────────────────────

export interface ChatLockState {
  release: () => Promise<void>;
  held: boolean;
}

export async function generateAndSendReplies(args: {
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
  let instructionInfo: import("../reply/instruction.js").InstructionInfo | null = null;
  try {
    const { detectInstruction } = await import("../reply/instruction.js");
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
                import("../turn/answered-store.js")
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
        import("../turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'model_silent')).catch(() => {});
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
            import("../turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'model_silent')).catch(() => {});
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
      import("../../tracking/social-needs.js")
        .then(({ markBotSpoke }) => markBotSpoke(job.chatId))
        .catch(() => {});
      // G9: speaking raises focus — the bot is now "in" the conversation
      if (e.TURN_FOCUS_ENABLED) {
        import("../turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'bot_spoke')).catch(() => {});
      }
      // L2: 落点入持续内心(立场延续,下一回合别自相矛盾)
      import("../heart/mind.js").then(({ noteStance }) => noteStance(job.chatId, sentMessages[0]?.text ?? '')).catch(() => {});
      // L5: 惦记两段式收尾(review #7):回复确认发出后才核销已注入的旧
      // 惦记(prompt 拼装只 peek 不删,被打断/抑制时问题保留下次再追),
      // **再**记录本次回复的新问句 —— 同一个 key,顺序反了会误删新问句。
      if (!formatted.isBot && !formatted.isAnonymous) {
        const lastSent = sentMessages.at(-1)?.text ?? '';
        import("../../tracking/curiosity.js")
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
      import("../turn/self-continue.js")
        .then(({ maybeSelfContinue }) => maybeSelfContinue(job.chatId, botUid))
        .catch(() => {});
    }

    // G7: mark every replied-to target (and the trigger itself) as answered
    if (sentMessages.length > 0) {
      const answeredIds = Array.from(new Set([
        formatted.messageId,
        ...replies.map((r) => r.targetMessageId).filter((id) => id > 0),
      ]));
      import("../turn/answered-store.js")
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
      import('../dm-relay/post-action.js').then(({ executePostAction }) => {
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
