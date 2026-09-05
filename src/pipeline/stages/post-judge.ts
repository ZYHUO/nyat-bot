// ────────────────────────────────────────
// Post-judge stage — path resolution, mute/sleep/timing gates,
// post-mute intercepts, reply generation.
// Extracted from pipeline.ts (pure extraction, no logic changes).
// ────────────────────────────────────────

import type { ChatJob, FormattedMessage, JudgeResult, ReplyPath } from "../../shared/types.js";
import { resolveReplyPath } from "../../shared/types.js";
import { applyChatPathPolicy } from "../path-policy.js";
import { TEMP_MUTE_CLEAR_RULES, DIRECT_INTERACTION_RULES, buildDeferEntry } from "../shared.js";
import { tryMuteCommandIntercepts, tryPreMuteIntercepts, tryPostMuteIntercepts } from "./intercepts.js";
import { generateAndSendReplies, type ChatLockState } from "./deliver.js";
import {
  getMuteState,
  unmuteUser,
} from "../../tracking/user-profile.js";
import { env } from "../../env.js";
import { logger } from "../../shared/logger.js";
import { recordGateNoAction } from "../timing/state-store.js";
import { scheduleGateDeferReeval } from "../timing/defer.js";
import { isTurnActorChat } from "../turn/flags.js";
import { updateObligationState } from "../turn/obligation-store.js";
import { runTimingGate } from "../timing/gate.js";
import {
  transitionToWait,
  transitionToStop,
  transitionToRunning,
  recordGateContinue,
  getChatState,
} from "../timing/chat-runtime.js";
import { loadCachedPrompt } from "../../shared/config.js";
import { setWaitAnchor } from "../turn/buffer.js";
import { getSleepPhase, sleepWakeDecision } from "../../tracking/sleep.js";
import { clearSleepPending, pushSleepPending } from "../../tracking/sleep-queue.js";
import { getBotDisplayName } from "../../bot/bot.js";
import { AIError } from "../../shared/errors.js";
import { needsLookup } from "../heart/path-heuristic.js";

export interface PostJudgeResult {
  /** true = pipeline should return (no reply or reply already sent) */
  completed: boolean;
}

export async function runPostJudge(ctx: {
  judgeResult: JudgeResult;
  formatted: FormattedMessage;
  job: ChatJob;
  e: ReturnType<typeof env>;
  botUid: number;
  recentMessages: FormattedMessage[];
  start: number;
  timings: Record<string, number>;
  lockState: ChatLockState;
  releaseHeldChatLock: () => Promise<void>;
  sleepBypass: boolean;
  burstHint?: string;
}): Promise<PostJudgeResult> {
  const { judgeResult, formatted, job, e, botUid, recentMessages, start, timings, lockState, releaseHeldChatLock, sleepBypass, burstHint } = ctx;

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
      const { microJudge } = await import("../judge/micro.js");
      const pathResult = await microJudge(
        formatted, recentMessages, botUid, "judge", "", job.chatId,
        job.turnContext?.signal, burstHint,
      );
      if (pathResult.replyPath) judgeResult.replyPath = pathResult.replyPath;
    }
  }

  const rawReplyPath = resolveReplyPath(judgeResult.action, judgeResult.replyPath);
  const pathPolicyDecision =
    judgeResult.action === "REPLY" && rawReplyPath
      ? await applyChatPathPolicy({ chatId: job.chatId, message: formatted, botUid, rawReplyPath })
      : { replyPath: rawReplyPath ?? "direct", matchedPatterns: [], source: "raw" as const };
  const effectiveReplyPath: ReplyPath = pathPolicyDecision.replyPath;

  logger.debug(
    {
      chatId: job.chatId, messageId: formatted.messageId,
      from: formatted.username || formatted.fullName,
      action: judgeResult.action, rawReplyPath, replyPath: effectiveReplyPath,
      pathPolicySource: pathPolicyDecision.source,
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
    return { completed: true };
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
    return { completed: true };
  }

  // 5.42 Pre-mute-gate intercepts (DM command guard, watch/game, consent reply)
  if (await tryPreMuteIntercepts(job.chatId, formatted, judgeResult)) {
    return { completed: true };
  }

  // 5.45 Mute gate
  if (!formatted.isAnonymous) {
    if (muteState.level === 2) {
      logger.debug({ chatId: job.chatId, uid: formatted.uid }, "Pipeline: user hard-muted bot, skipping reply");
      return { completed: true };
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
      return { completed: true };
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
        return { completed: true };
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
    const isDirect = !!(judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule));
    const tg = performance.now();
    let botPersona = '';
    try {
      try {
        botPersona = loadCachedPrompt('identity/behavior-style.md');
      } catch {
        botPersona = loadCachedPrompt('identity/persona.md');
      }
    } catch { /* non-fatal */ }
    // 预读 timing state(审计 #38:一份快照供 lastSpokeSecAgo + gate 内
    // 连续免检/冷却/talk_value 共用,避免重复 HGETALL)。读失败 → undefined,
    // gate 内自行兜底。
    let prefetchedState: Awaited<ReturnType<typeof getChatState>> | undefined =
      job.turnContext?.timingStateSnapshot;
    let lastSpokeSecAgo: number | undefined;
    try {
      if (prefetchedState === undefined) {
        prefetchedState = await getChatState(job.chatId);
      }
      if (prefetchedState.lastBotReplyAt) {
        lastSpokeSecAgo = (Date.now() - prefetchedState.lastBotReplyAt) / 1000;
      }
    } catch { /* non-critical */ }
    const gateDecision = await runTimingGate({
      chatId: job.chatId,
      message: formatted,
      recentMessages,
      judgeResult,
      botUid,
      botName: getBotDisplayName(),
      botPersona,
      isDirectInteraction: isDirect,
      signal: job.turnContext?.signal,
      lastSpokeSecAgo,
      triggerUid: formatted.uid,
      obligationId: job.turnContext?.obligationId,
      obligationTargetUid: job.turnContext?.obligationTargetUid,
      obligationStrong: job.turnContext?.obligationStrong,
      prefetchedState,
      skipShortCircuits: job.turnContext?.skipGateCooldown,
      // P0-B/P1-C:仅 turn actor 路径支持 defer 延迟重评(非 actor 无 pending
      // 缓冲可回放,defer 会退化成丢消息 → 不开)。
      canDefer: !!job.turnContext && isTurnActorChat(job.chatId),
      deferCount: job.turnContext?.deferCount,
    });
    timings["timing_gate"] = Math.round(performance.now() - tg);

    // G3: 打断发生在 gate 推理期间 → 不要基于陈旧状态提交 WAIT/STOP,
    // 上抛给 actor 带新消息重规划(replan 时 gateBypass)。
    if (job.turnContext?.signal?.aborted) {
      throw new AIError("Turn interrupted during gate", "gate", "gate", "AI_ABORTED");
    }

    if (gateDecision.action === 'wait') {
      if (e.TURN_FOCUS_ENABLED && job.chatId < 0) {
        import("../turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'gate_wait')).catch((err) => logger.debug({ err, chatId: job.chatId }, 'bumpFocus failed (non-critical)'));
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
              obligationId: job.turnContext?.obligationId,
              obligationTargetUid: job.turnContext?.obligationTargetUid,
              obligationStrong: job.turnContext?.obligationStrong,
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
        formatted.uid,
        job.turnContext?.obligationId,
      );
      const totalMs = Math.round(performance.now() - start);
        logger.info(
          { chatId: job.chatId, totalMs, waitSec: gateDecision.waitSec, reason: gateDecision.reason, triggerUid: formatted.uid, timings },
          "Pipeline complete (gate=wait, no reply)",
        );
      return { completed: true };
    }

    if (gateDecision.action === 'no_action') {
      // 冷却期/阈值未达延后:这条不回,但保持 RUNNING(不锁死整个 chat)。
      // P0-B:actor 路径不再丢消息 —— 重新入 pending 并排 gate_defer 回合,
      // 到点(冷却已过/消息攒够)带完整语境重评(MaiBot delayed-task 语义)。
      if (gateDecision.deferOnly) {
        const canReschedule = !!job.turnContext && isTurnActorChat(job.chatId);
        let rescheduled = false;
        if (canReschedule && job.turnContext) {
          rescheduled = await scheduleGateDeferReeval({
            chatId: job.chatId,
            entry: buildDeferEntry(job, formatted),
            deferCount: job.turnContext.deferCount ?? 0,
            retryAfterMs: gateDecision.retryAfterMs ?? e.TIMING_GATE_COOLDOWN_SEC * 1000,
            reason: gateDecision.reason,
          }).catch((err) => {
            logger.warn({ err, chatId: job.chatId }, "scheduleGateDeferReeval failed");
            return false;
          });
        }
        if (rescheduled) {
          const totalMs = Math.round(performance.now() - start);
          logger.info(
            { chatId: job.chatId, totalMs, reason: gateDecision.reason, retryAfterMs: gateDecision.retryAfterMs, triggerUid: formatted.uid, timings },
            "Pipeline complete (gate defer → timed re-eval)",
          );
          return { completed: true };
        }
        if (canReschedule) {
          // review R3#3:actor chat 但重排失败 —— judge 早已判 REPLY,
          // 这里"烧一次"(照常回复)而不是静默丢弃,与心流路径的
          // bypassEngagementHardPass 同一"burn 而非 drop"契约(R2#9)。
          // 不 return,穿透到下方 continue 路径的 recordGateContinue + 回复。
          logger.warn(
            { chatId: job.chatId, reason: gateDecision.reason, triggerUid: formatted.uid },
            "gate defer reschedule failed, burning (reply now) instead of drop",
          );
        } else {
          // 非 actor chat:无 pending 缓冲可回放,defer 只能退化为静默丢弃
          // (旧 TURN_GATE_DEFER_COOLDOWN 语义,未变)。
          const totalMs = Math.round(performance.now() - start);
          logger.info(
            { chatId: job.chatId, totalMs, reason: gateDecision.reason, triggerUid: formatted.uid, timings },
            "Pipeline complete (gate cooldown defer, no reply — non-actor)",
          );
          return { completed: true };
        }
      } else {
      if (e.TURN_FOCUS_ENABLED && job.chatId < 0) {
        import("../turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'gate_no_action')).catch((err) => logger.debug({ err, chatId: job.chatId }, 'bumpFocus failed (non-critical)'));
      }
      // actor 模式:no_action = 这条不接,但**人还在场**(只记冷却,不 STOP)。
      // 旧 enterStop 会把 chat 锁死到被 @ 才醒 → "说几下就跑了"。
      if (job.turnContext) {
        await recordGateNoAction(job.chatId, formatted.uid).catch((err) => logger.debug({ err, chatId: job.chatId }, 'recordGateNoAction failed (non-critical)'));
        if (job.turnContext.obligationId) {
          await updateObligationState(job.chatId, job.turnContext.obligationId, 'dropped', { reason: gateDecision.reason || 'gate_no_action' }).catch((err) => logger.debug({ err, chatId: job.chatId }, 'updateObligationState failed (non-critical)'));
        }
      } else {
        await transitionToStop(job.chatId, formatted.uid);
      }
      const totalMs = Math.round(performance.now() - start);
      logger.info(
        { chatId: job.chatId, totalMs, reason: gateDecision.reason, triggerUid: formatted.uid, timings },
        "Pipeline complete (gate=no_action, no reply)",
      );
      return { completed: true };
      } // end else (regular no_action drop; deferOnly-burn falls through to reply)
    }

    // continue → record + transition (no-op if already RUNNING) and fall through。
    // P0-A:连续免检短路**不**记 continue —— 免检自己续窗会变永动机,窗口
    // 只由真实 LLM continue 和真实 bot 回复刷新。
    if (!gateDecision.continuation) {
      await recordGateContinue(job.chatId);
      await transitionToRunning(job.chatId);
    }
  } else if (e.FLOOR_ENABLED && !job.turnContext?.gateBypass) {
    // H1.2 silence 收敛(无 gate 时的确定性沉默层):gate LLM 关着的群,
    // 用 0ms 本地三律代替 —— self_chase/hot_lurk/dead_chat 直接落库返回,
    // 不烧 judge/reply。点名(@/回复bot/私聊)永不沉默;to_me 强义务豁免。
    // replan/waitReplay 不走这里(上面 G3 分支已跳过 judge)。
    const isDirect = !!(judgeResult.rule && DIRECT_INTERACTION_RULES.has(judgeResult.rule));
    if (!isDirect && judgeResult.action === "REPLY" && job.chatId < 0) {
      try {
        const { shouldStaySilent } = await import("../rhythm/silence.js");
        const { getChatState } = await import("../timing/chat-runtime.js");
        const tstate = await getChatState(job.chatId).catch(() => undefined);
        const nowMs = Date.now();
        const nowSec = Math.floor(nowMs / 1000);
        const addressed = judgeResult.rule === "reply_to_self" || judgeResult.rule === "mention_self";
        const strongObligation = !!job.turnContext?.obligationStrong;
        if (!addressed && !strongObligation) {
          const s = shouldStaySilent({
            recentMessages: recentMessages.map((m) => ({ uid: m.uid, timestamp: m.timestamp })),
            botUid,
            nowMs,
            lastBotReplyAtMs: tstate?.lastBotReplyAt,
            messagesLast1Min: recentMessages.filter((m) => m.timestamp >= nowSec - 60).length,
            addressedToBot: false,
          });
          if (s.silent) {
            const totalMs = Math.round(performance.now() - start);
            logger.info(
              { chatId: job.chatId, messageId: formatted.messageId, reason: s.reason, totalMs },
              "Pipeline complete (silence: stayed quiet, context saved)",
            );
            return { completed: true };
          }
        }
      } catch (err) {
        logger.debug({ err, chatId: job.chatId }, "silence check failed (non-critical, fall through)");
      }
    }
  }

  // 5.5-5.7 Post-mute-gate intercepts
  if (await tryPostMuteIntercepts(job.chatId, formatted, judgeResult)) {
    return { completed: true };
  }

  await releaseHeldChatLock();

  // 6-11: Reply generation, send, and post-send bookkeeping
  await generateAndSendReplies({
    job, formatted, judgeResult, botUid,
    effectiveReplyPath,
    e, start, timings, lockState, releaseHeldChatLock,
  });

  return { completed: true };
}
