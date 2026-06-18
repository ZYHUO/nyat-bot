// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type { ChatJob, JudgeResult } from "../shared/types.js";
import { resolveReplyPath, resolveReplyTier } from "../shared/types.js";
import { formatMessage } from "./formatter.js";
import { addMessage, getRecent } from "./context/manager.js";
import { judge, l0Rule } from "./judge/judge.js";
import { processMedia } from "./stages/media.js";
import { applyChatPathPolicy } from "./path-policy.js";
import { sender, TEMP_MUTE_CLEAR_RULES, DIRECT_INTERACTION_RULES } from "./shared.js";
import { tryMuteCommandIntercepts, tryPreMuteIntercepts, tryPostMuteIntercepts } from "./stages/intercepts.js";
import { generateAndSendReplies, type ChatLockState } from "./stages/deliver.js";
import { sendMessage } from "../bot/sender/telegram.js";
import { getBotUid } from "../bot/bot.js";
import { recordMessage as recordActivity, getActivitySummary } from "../tracking/activity.js";
import { getBotTracker } from "../tracking/interaction.js";
import { tryGenerateDigest } from "../tracking/bot-digest.js";
import {
  checkOutcome,
  generateReflection,
} from "../tracking/outcome.js";
import {
  recordUserMessage,
  getMuteState,
  unmuteUser,
} from "../tracking/user-profile.js";
import { memorizeMessage } from "../memory/chroma.js";
import { maybeReact } from "./reactions.js";
import { recordInteraction } from "../tracking/social-graph.js";
import { getRedis } from "../db/redis.js";
import { callWithFallback } from "../ai/fallback.js";
import { handlePendingGroupSelection } from "./dm-relay/relay.js";
import {
  getPendingGroupSelection,
  clearPendingGroupSelection,
} from "./dm-relay/group-resolver.js";
import { acquireChatLock } from "../queue/chat-lock.js";
import { AIError } from "../shared/errors.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { checkWatches } from "../tracking/topic-watch.js";
import { recordMessage as recordStatMessage } from "../tracking/stats.js";
import { recordGateNoAction } from "./timing/state-store.js";
import { playGame, hasActiveGame } from "./games/manager.js";
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
import { getFocus as getChatFocus } from "./turn/focus.js";
import { getLifeState } from "../tracking/life-state.js";
import { getSleepPhase, sleepStageAVerdict, sleepWakeDecision } from "../tracking/sleep.js";
import { pushSleepPending, clearSleepPending } from "../tracking/sleep-queue.js";


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

    // 3.0 bot 消息分类(地基,shadow:只打标 + 日志,不改行为)。其他 bot
    // 的入站消息打 botClass,供后续 A 互动 / D 降噪 / 命令学习共用一个判定。
    if (e.BOT_CLASSIFIER_ENABLED && formatted.isBot && formatted.uid !== botUid && job.chatId < 0) {
      try {
        const { classifyBotMessage } = await import("../tracking/bot-classifier.js");
        const { getProfilesForBot } = await import("../learners/bot-command-store.js");
        const hasProfile = formatted.username ? getProfilesForBot(formatted.username).length > 0 : false;
        formatted.botClass = classifyBotMessage(formatted, { hasCommandProfile: hasProfile });
        logger.info(
          { chatId: job.chatId, bot: formatted.username, botClass: formatted.botClass },
          "Bot message classified (shadow)",
        );
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "bot classify failed (non-critical)");
      }
    }

    // D 降噪:ad/verify/echo 类其他 bot 消息 → 不进 digest/学习、不烧 judge
    //(但保留进 ctx)。在 bookkeeping 与 judge 前都要用,故在此作用域声明。
    const isDenoiseBot = e.BOT_DENOISE_ENABLED &&
      (formatted.botClass === "ad" || formatted.botClass === "verify" || formatted.botClass === "echo");

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

    // 3.1f 网络事件 burst(C)— 集体喊"挂了/CF炸了"时冒一句(fire-and-forget,
    // 30s 滑窗 + 10min 冷却 + 作息/抑制门;内部先匹配故障词,非故障消息零开销)。
    if (job.chatId < 0 && !formatted.isBot && env().NETWORK_BURST_ENABLED) {
      import("./games/network-burst.js")
        .then(({ maybeNetworkBurst }) => maybeNetworkBurst(job.chatId, formatted, botUid))
        .catch(() => {});
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

    // 3.345 DM 好感(功能 B):记录私聊过(供睡前/起床 DM 资格)+ 停 @催pm +
    // flush 攒着的话。全程 fire-and-forget,不阻塞管线;flush 仅在有攒话时动工。
    if (job.chatId > 0 && !formatted.isBot) {
      void (async () => {
        try {
          const { markDmEver, markPmDmOpen } = await import('../tracking/dm-state.js');
          markDmEver(formatted.uid);
          markPmDmOpen(formatted.uid);
          const { countDmPending } = await import('../tracking/dm-pending.js');
          if (countDmPending(formatted.uid) > 0) {
            const { flushDmPendingOnInbound } = await import('./dm-proactive.js');
            await flushDmPendingOnInbound(formatted.uid);
          }
        } catch (err) {
          logger.debug({ err }, 'DM affinity inbound hook failed (non-critical)');
        }
      })();
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

    // 3.6 Bot interaction tracking(D 降噪:ad/verify/echo 不进 digest/学习)
    if (formatted.isBot && formatted.username && !isDenoiseBot) {
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

    // 3.96 代发回执:这条 bot 消息是不是我们代发命令的结果?是则消费它并
    // 用结果另起一条回复答原问题(否则它会在 judge 被当普通 bot 消息忽略)。
    // flag 关时 tryHandleDelegationReceipt 直接返回 false,零开销。
    if (formatted.isBot) {
      try {
        const { tryHandleDelegationReceipt } = await import("./tools/bot-delegation.js");
        if (await tryHandleDelegationReceipt(job.chatId, formatted, botUid)) {
          logger.info({ chatId: job.chatId, bot: formatted.username }, "Pipeline complete (delegation receipt handled)");
          return;
        }
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "delegation receipt check failed (non-critical)");
      }
    }

    // 3.965 D 降噪:ad/verify/echo 类其他 bot 消息(已在 ctx,不删)→ tracking-only,
    // 不烧 judge/heart。顺序在代发回执(3.96)之后:cmd_result 先被回执认领,
    // 这里只拦广告/验证/复读。
    if (isDenoiseBot) {
      logger.info(
        { chatId: job.chatId, bot: formatted.username, botClass: formatted.botClass },
        "Pipeline complete (denoise: bot ad/verify/echo silenced)",
      );
      return;
    }

    // 3.97 A 多 bot 共存:会话型 bot(千雪)/带媒体的工具结果(解析姬)→ 另起
    // 一条 peer 反应(fire-and-forget,自带 chat-lock/fatigue/作息门/@我让位)。
    // 在代发回执之后:cmd_result 若是我们点的命令回执,3.96 已认领并 return。
    // 不 early-return:非点名 bot 消息后面 L0 bot_message 会 0ms IGNORE。
    if (e.PEER_REACTION_ENABLED && formatted.isBot && formatted.uid !== botUid &&
        (formatted.botClass === "chat" || formatted.botClass === "cmd_result")) {
      import("./games/peer-reaction.js")
        .then(({ maybePeerReaction }) => maybePeerReaction(job.chatId, formatted, botUid))
        .catch(() => {});
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

    // 4.05 睡眠门 Stage A(硬作息 v2):睡着时指令/点名/功能规则放行
    // (命令分发层与 Stage B 接手);对话热度类 L0 自动接话不烧 judge,
    // 直接攒进睡眠队列;L1/heart 闲聊按预算放 judge 判"值不值得回"
    // (REPLY 会在 Stage B 入队),预算外静默。补回回放(sleepCatchup)
    // 绕过整个睡眠门 —— 防半夜补回被再次入队死循环。
    const sleepBypass = job.turnContext?.sleepCatchup === true;
    const sleepPhaseA = sleepBypass ? "awake" : await getSleepPhase();
    if (sleepPhaseA !== "awake") {
      const l0 = l0Rule({
        message: formatted, recentMessages, botUid,
        botUsername: e.BOT_USERNAME, botNicknames: e.BOT_NICKNAMES,
        chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
      });
      const verdictA = await sleepStageAVerdict(job.chatId, l0, sleepPhaseA);
      if (verdictA === "queue") {
        const queued = await pushSleepPending(job.chatId, {
          entry: {
            update: job.update, chatId: job.chatId, messageId: formatted.messageId,
            enqueuedAt: job.enqueuedAt, waitReplay: true, sleepCatchup: true,
          },
          rule: l0?.rule,
          ts: Date.now(),
        });
        logger.info(
          { chatId: job.chatId, messageId: formatted.messageId, rule: l0?.rule ?? null },
          queued
            ? "Pipeline complete (asleep, queued for catch-up)"
            : "Pipeline complete (asleep, not replayable, silenced)",
        );
        return;
      }
      if (verdictA === "silent") {
        logger.info(
          { chatId: job.chatId, messageId: formatted.messageId, rule: l0?.rule ?? null },
          "Pipeline complete (asleep, chatter silenced)",
        );
        return;
      }
    }

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
      // 审计 #38 slice 3:timing 状态一回合只读一次 —— 冷却判断与
      // lastSpokeSecAgo 共用同一份快照(旧码同一 hash 读 2 次)。
      let tstate: Awaited<ReturnType<typeof getChatState>> | undefined;
      if (!l0) {
        try { tstate = await getChatState(job.chatId); } catch { /* non-critical */ }
      }
      if (l0) {
        judgeResult = l0;
      } else if (await isInGateCooldown(job.chatId, tstate)) {
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
        // 审计 #38 slice 2:快照挂上 turnContext,写手同回合直接复用
        job.turnContext.selfState = selfState;
        let lastSpokeSecAgo: number | undefined;
        if (tstate?.lastBotReplyAt) lastSpokeSecAgo = (Date.now() - tstate.lastBotReplyAt) / 1000;
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
        // P2 决策流安全网:心流判 chat(→direct,无工具),但消息有明确检索意图
        // (查/搜/价格/点歌/带链接…)→ 升级 planned。心流偶尔低估"需要查"的
        // 信号,direct 路径就查不了;关键词兜底用与 L0 路由同一套 needsLookup。
        if (
          judgeResult.action === "REPLY" &&
          judgeResult.replyPath === "direct" &&
          needsLookup(formatted.textContent || formatted.captionContent || "")
        ) {
          judgeResult.replyPath = "planned";
          logger.info(
            { chatId: job.chatId, why: heart.why },
            "heart=chat upgraded to planned (explicit lookup intent)",
          );
        }
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

    // 5.45b 睡眠门 Stage B(硬作息 v2):slash/NL 指令已在上面的拦截层分发
    // 完。功能规则豁免(post-mute 拦截与 /checkin /stats 的 LLM 渲染还要处
    // 理);点名(@/回 bot/私聊)掷"升级式吵醒"骰子:主人必醒,越 ping 越
    // 容易醒,午睡浅概率翻倍;没醒的点名与 judge 判 REPLY 的闲聊 → 攒进
    // 睡眠队列,半夜醒/早上起床后补。被吵醒 → 清该 chat 队列("看过手机
    // 了"),回复自带迷糊语气(self-state)+ 迷糊窗口内继续接话。
    if (!sleepBypass) {
      const sleepPhaseB = await getSleepPhase();
      if (sleepPhaseB !== "awake") {
        const verdict = await sleepWakeDecision(job.chatId, formatted.uid, judgeResult.rule, sleepPhaseB);
        if (verdict === "wake") {
          await clearSleepPending(job.chatId);
        } else if (verdict === "queue") {
          const queued = await pushSleepPending(job.chatId, {
            entry: {
              update: job.update, chatId: job.chatId, messageId: formatted.messageId,
              enqueuedAt: job.enqueuedAt, waitReplay: true, sleepCatchup: true,
            },
            rule: judgeResult.rule,
            ts: Date.now(),
          });
          const totalMs = Math.round(performance.now() - start);
          logger.info(
            { chatId: job.chatId, totalMs, rule: judgeResult.rule, timings },
            queued
              ? "Pipeline complete (asleep, queued for catch-up)"
              : "Pipeline complete (asleep, not replayable, silenced)",
          );
          return;
        }
        // 'pass'(豁免)/'wake'(被吵醒)→ 继续往下走
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
