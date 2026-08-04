// ────────────────────────────────────────
// Pipeline Orchestrator — full message pipeline
// ────────────────────────────────────────

import type { ChatJob, JudgeResult } from "../shared/types.js";
import { formatMessage } from "./formatter.js";
import { getRecent } from "./context/manager.js";
import { judge, l0Rule } from "./judge/judge.js";
import { processMedia } from "./stages/media.js";
import { runBookkeeping } from "./stages/bookkeeping.js";
import { runPostJudge } from "./stages/post-judge.js";
import type { ChatLockState } from "./stages/deliver.js";
import { getBotUid, getBotIdentity } from "../bot/bot.js";
import { getActivitySummary } from "../tracking/activity.js";
import { memorizeMessage } from "../memory/chroma.js";
import { acquireChatLock } from "../queue/chat-lock.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { getFocus as getChatFocus } from "./turn/focus.js";
import { getLifeState } from "../tracking/life-state.js";
import { getSleepPhase, sleepStageAVerdict, pokeGlobalWake } from "../tracking/sleep.js";
import { hasDmEver } from "../tracking/dm-state.js";
import { isMaster } from "../admin/auth.js";
import { pushSleepPending } from "../tracking/sleep-queue.js";
import { runHeartBranch } from "./heart/heart.js";

// ── Main pipeline orchestrator ──────────────────────────────────────

export async function processPipeline(job: ChatJob): Promise<void> {
  const start = performance.now();
  // 注:msg_seen 不在这里记 —— 它挪到了 bot/handlers/message.ts 的 handleUpdate。
  // 生产开着 META_SUBAGENT_ENABLED,Meta 路径在入队之前就分流走了,记在这里会
  // 漏掉主路径(实测决策 38 次而这里只记到 4)。
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
  const botIdentity = getBotIdentity();

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
    // review #10: defer replay also skips bookkeeping(已在首轮记过账),但
    // **不**跳 judge/heart —— 与 isWaitReplay 分开变量,防止再被合流进
    // "跳过 judge、强制 REPLY" 那条分支(那正是 #10 的根因)。
    const isDeferReplay = job.turnContext?.isDeferReplay === true;

    if (!isWaitReplay && !isDeferReplay) {
      const bkResult = await runBookkeeping({
        formatted,
        chatId: job.chatId,
        botUid,
        botIdentity,
        isWaitReplay,
        isDeferReplay,
        isDenoiseBot,
        timings,
        job,
      });
      if (bkResult?.shouldAbort) {
        logger.debug({ chatId: job.chatId, reason: bkResult.reason }, "Pipeline complete (bookkeeping intercept)");
        return;
      }
    } // end !isWaitReplay && !isDeferReplay bookkeeping block (G5/P0-B)

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
        .catch((err) => logger.debug({ err, chatId: job.chatId }, 'peer-reaction failed (non-critical)'));
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
    // DM↔群联动:私聊来消息 → 全局临时唤醒(令本条 DM 及随后群消息都按醒处理,窗口内每条 DM 续期)。
    // 必须在下面 getSleepPhase 之前 poke,这条 DM 自己才不被睡眠门拦。flag 关 → no-op。
    // 仅限主人或已建立私聊关系的熟人触发(评审 Finding 2):防陌生人半夜一条 DM 就把 bot 全局唤醒。
    if (
      e.SLEEP_WAKE_ON_DM_ENABLED && job.chatId > 0 && !sleepBypass &&
      (isMaster(formatted.uid, e.MASTER_UID) || hasDmEver(formatted.uid))
    ) {
      await pokeGlobalWake('dm');
    }
    const sleepPhaseA = sleepBypass ? "awake" : await getSleepPhase();
    if (sleepPhaseA !== "awake") {
      const l0 = l0Rule({
        message: formatted, recentMessages, botUid,
        botUsername: botIdentity.username, botNicknames: botIdentity.nicknames,
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
    // burst 是否多人。优先用 actor 直传的 burstUids(L3:不依赖 recentMessages
    // 的 30 条窗口,老消息掉出窗口也能正确判多人);没有则回退到用 recentMessages
    // 把 id 映射成 uid(非 actor 路径兜底)。多锚点模式下每组 burstUids 只 1 个 uid。
    const burstUidSet = new Set<number>();
    const burstUidsFromCtx = job.turnContext?.burstUids;
    if (burstUidsFromCtx && burstUidsFromCtx.length > 0) {
      for (const u of burstUidsFromCtx) burstUidSet.add(u);
    } else if (burstIds.length > 1) {
      for (const id of burstIds) {
        const m = recentMessages.find((rm) => rm.messageId === id);
        if (m) burstUidSet.add(m.uid);
        if (burstUidSet.size > 1) break;
      }
    }
    const burstHint = burstIds.length > 1
      ? burstUidSet.size > 1
        ? `[多人提示] 最近的 ${burstIds.length} 条消息来自不同的人（约 ${burstUidSet.size} 位，${burstIds.map((id) => `#${id}`).join('、')}），不是同一个人的连发。请只针对你真正要回的那个人/那条来判断，reply 指向那个人的消息，别把别人的话算到锚点人头上。`
        : `[连发提示] 最新的 ${burstIds.length} 条消息（${burstIds.map((id) => `#${id}`).join('、')}）是同一波连发，很可能是一个完整的念头分几条打出来的。请把整波作为一个整体来判断（回不回、值不值得回），不要只盯最后一条——重点经常在前面几条里。`
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
        botUsername: botIdentity.username, botNicknames: botIdentity.nicknames,
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
      const heartResult = await runHeartBranch({
        formatted, recentMessages, botUid, botIdentity, job, e,
        messagesLast5Min, messagesLast1Hour, burstHint, focusLevel,
      });
      if (heartResult.shouldReturn) return;
      judgeResult = heartResult.judgeResult!;
    } else {
      judgeResult = await judge({
        message: formatted, recentMessages,
        recentMessagesL2Fetcher: () => getRecent(job.chatId, e.JUDGE_WINDOW_SIZE * 3),
        botUid, botUsername: botIdentity.username, botNicknames: botIdentity.nicknames,
        chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
        burstHint,
        focus: focusLevel,
      });
    }
    timings["judge"] = Math.round(performance.now() - t3);

    // Post-judge: path resolution, mute/sleep/timing gates, reply generation
    const postResult = await runPostJudge({
      judgeResult,
      formatted,
      job,
      e,
      botUid,
      recentMessages,
      start,
      timings,
      lockState,
      releaseHeldChatLock,
      sleepBypass,
      burstHint,
    });
    if (postResult.completed) return;
  } finally {
    await releaseHeldChatLock();
  }
}

