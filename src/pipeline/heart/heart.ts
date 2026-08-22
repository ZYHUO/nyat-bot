// ────────────────────────────────────────
// Heart orchestration — 心流路径 (S13/G8)
// 一颗心代替三个过滤器。Extracted from pipeline.ts (pure extraction, no logic changes).
// ────────────────────────────────────────

import type { ChatJob, FormattedMessage, JudgeResult } from "../../shared/types.js";
import { l0Rule, judge } from "../judge/judge.js";
import { getRecent } from "../context/manager.js";
import {
  getChatState,
  getGateCooldownRemainingMs,
  isInContinuation,
  transitionToWait,
} from "../timing/chat-runtime.js";
import { isTurnActorChat } from "../turn/flags.js";
import { scheduleGateDeferReeval, hasDeferBudget } from "../timing/defer.js";
import { computeEngagement, filterForTurnStart, HARD_PASS_BUDGET, isBotMonologueTrail } from "./engagement.js";
import { composeSelfState } from "./self-state.js";
import { heartDecision } from "./decision.js";
import { getBotDisplayName } from "../../bot/bot.js";
import { setWaitAnchor } from "../turn/buffer.js";
import { recordGateNoAction } from "../timing/state-store.js";
import { needsLookup } from "./path-heuristic.js";
import { logger } from "../../shared/logger.js";
import { buildDeferEntry } from "../shared.js";
import { env } from "../../env.js";

export interface HeartResult {
  /** true = pipeline should return immediately (side effects + logging already done) */
  shouldReturn: boolean;
  /** judgeResult when shouldReturn=false (from l0, heart, or legacy judge fallback) */
  judgeResult?: JudgeResult;
}

export async function runHeartBranch(ctx: {
  formatted: FormattedMessage;
  recentMessages: FormattedMessage[];
  botUid: number;
  botIdentity: { username: string; nicknames: string[] };
  job: ChatJob;
  e: ReturnType<typeof env>;
  messagesLast5Min: number;
  messagesLast1Hour: number;
  burstHint?: string;
  focusLevel: number | undefined;
}): Promise<HeartResult> {
  const { formatted, recentMessages, botUid, botIdentity, job, e, messagesLast5Min, messagesLast1Hour, burstHint, focusLevel } = ctx;

  // Caller guarantees job.turnContext is defined (heart path condition:
  // e.HEART_ENABLED && job.chatId < 0 && job.turnContext).
  if (!job.turnContext) return { shouldReturn: true };

  let judgeResult: JudgeResult;

  // ── 心流路径(S13/G8):一颗心代替三个过滤器 ──
  // L0 规则先跑(0ms 快路:@/回复bot/命令/mute/游戏等确定性场景)。
  // 未命中 → 一次带人格+自我状态的心流判断,直接给出 reply/wait/pass
  // (它就是 gate,后面的 gate 块对 heart 路径跳过)。
  const l0Raw = l0Rule({
    message: formatted, recentMessages, botUid,
    botUsername: botIdentity.username, botNicknames: botIdentity.nicknames,
    chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
  });
  // "对话热度"类 L0 规则(bot 刚说过话 → 骰子自动 REPLY)在心流模式
  // 下**降级为建议**:它们曾绕过心流和刷屏闸形成自激循环(bot 说一句
  // → 后续消息命中跟进规则 → 自动回 → 永远"刚说过话" → 69 次回复里
  // 只有 12 次经过心流)。被点名(@/回复 bot/命令)仍然直通。
  const CONVERSATIONAL_L0 = new Set(["followup_to_bot", "active_conv_engage"]);
  // hot_chat 骰子同样降级:P2 用确定性的参与预算(velocity 因子)替代 RNG
  const demoteReply = l0Raw && l0Raw.action === "REPLY" && CONVERSATIONAL_L0.has(l0Raw.rule ?? "");
  // recent_reply 同降:bot 刚说完话后的短追问("?"/"对")是最典型的被吞
  // 消息类,让心流带人格判,别 0ms 硬丢。
  const demoteIgnore = l0Raw && l0Raw.action === "IGNORE" && (l0Raw.rule === "hot_chat" || l0Raw.rule === "recent_reply");
  const l0 = demoteReply || demoteIgnore ? null : l0Raw;
  // 审计 #38 slice 3:timing 状态一回合只读一次 —— 冷却判断与
  // lastSpokeSecAgo 共用同一份快照(旧码同一 hash 读 2 次)。
  // review #10:优先用 actor 回合开始时的快照(多锚点各组共用,组1 的
  // 中途写入不误伤组2;回合前已有的冷却对所有组照常生效)。
  let tstate: Awaited<ReturnType<typeof getChatState>> | undefined =
    job.turnContext.timingStateSnapshot;
  if (!l0 && tstate === undefined) {
    try { tstate = await getChatState(job.chatId); } catch { /* non-critical */ }
  }
  // P0-A 连续对话免检(心流路径版):bot 刚回复过/心流刚放行过的窗口内,
  // 跳过冷却丢弃与参与预算硬阈,让心流自己决定 —— 心流≈MaiBot 的
  // planner,连续 Planner 状态下消息直达 planner 不过闸。心流一旦 pass
  // (负向决策更新 lastGateAt)免检立刻失效,自限不会永动。
  const heartContinuation =
    e.TURN_GATE_CONTINUATION && tstate !== undefined && isInContinuation(tstate);
  if (l0) {
    judgeResult = l0;
  } else {
    // review #9:冷却 defer 预算耗尽/排程失败后"穿透给心流裁决"必须是
    // 真裁决——若紧接着又被下面的参与预算硬阈无 LLM 判决地拦掉,#1 的
    // "预算耗尽→多烧一次 LLM 而非丢消息"承诺在心流路径就是句空话。
    let bypassEngagementHardPass = false;
    const cooldownRemainingMs =
      job.turnContext?.skipGateCooldown || heartContinuation
        ? 0
        : await getGateCooldownRemainingMs(job.chatId, tstate);
    if (cooldownRemainingMs > 0) {
      // 冷却短路:刚 pass/wait 过 → 不再为每条消息烧一次心流调用。
      // P0-B:defer 语义下不丢消息 —— 重排到冷却结束带完整语境重评
      // (MaiBot delayed-task)。重放预算耗尽/排程失败 → **穿透给心流
      // 裁决**(review #1:兜底方向是多烧一次 LLM,不是丢消息);
      // flag 关保持旧静默丢弃。
      const deferMode = e.TURN_GATE_DEFER_COOLDOWN && isTurnActorChat(job.chatId);
      if (!deferMode) {
        logger.debug({ chatId: job.chatId, uid: formatted.uid, lastGateUid: tstate?.lastGateUid }, "Heart skipped (cooldown), pass");
        return { shouldReturn: true };
      }
      if (hasDeferBudget(job.turnContext.deferCount)) {
        const rescheduled = await scheduleGateDeferReeval({
          chatId: job.chatId,
          // review R3#5:与 gate 路径共用 buildDeferEntry,obligation 字段
          // (非 @ 问句的 strong obligation)不再靠两处手写同步,永不漂移。
          entry: buildDeferEntry(job, formatted),
          deferCount: job.turnContext.deferCount ?? 0,
          retryAfterMs: cooldownRemainingMs,
          reason: 'heart_cooldown_defer',
        }).catch(() => false);
        if (rescheduled) {
          logger.info(
            { chatId: job.chatId, uid: formatted.uid, cooldownRemainingMs },
            "Heart cooldown → timed re-eval scheduled",
          );
          return { shouldReturn: true };
        }
        logger.warn({ chatId: job.chatId }, "Heart cooldown defer reschedule failed, falling through to heart");
        bypassEngagementHardPass = true;
      } else {
        logger.info(
          { chatId: job.chatId, deferCount: job.turnContext.deferCount },
          "Heart cooldown defer budget exhausted, falling through to heart",
        );
        bypassEngagementHardPass = true;
      }
    }
    // P2 参与预算:占比/速率/群速/精力 合成一个 0..1 标量。
    // 硬阈以下确定性 pass(不烧心流调用);中间带给心流一句体感注记。
    // P0-A:连续免检窗口内跳过硬阈 —— 对话进行中 bot 占比天然偏高,
    // 硬阈恰好会造成"聊两句就蒸发";让心流自己决定去留。
    // 分人回复修复:多锚点回合里,组1 的回复经 addAssistant 写入共享上下文
    // 后,组2/3 若直接用实时 recentMessages 算 engagement,会被组1 刚发的
    // 这条推高 share/replies5m,命中硬阈静默 pass ——"永远只回一句"的主因。
    // 过滤掉 turnStartedAt(回合开始)之后才出现的 bot 消息(即本回合内
    // 兄弟组已发的回复),只让"回合开始前"的真实状态计入预算;用户消息
    // 与回合开始前就存在的历史 bot 消息不受影响,跨回合防刷照常生效。
    const engagementMessages = filterForTurnStart(recentMessages, botUid, job.turnContext?.turnStartedAt);
    // 自发言环：continuation 免检时也拦（群里自己接自己话）。
    if (isBotMonologueTrail(engagementMessages, botUid, 8, formatted.messageId)) {
      logger.info(
        { chatId: job.chatId, uid: formatted.uid },
        "Heart skipped (bot monologue trail), pass",
      );
      return { shouldReturn: true };
    }
    const engagement = computeEngagement(engagementMessages, botUid, messagesLast5Min);
    // 硬阈三处修正(2026-07-04 吞消息诊断):
    // (1) defer 回放豁免 —— defer 的意义是"到点让心流重评",回放后作为
    //     lone entry 再撞确定性硬阈等于白 defer(生产实证 Incident C:
    //     defer 15s 后 resume,兄弟组已回 4 条 → replies5m=4 → 静默吞)。
    // (2) 强债务豁免 —— 明确问句(obligationStrong)不该被无 LLM 的份额闸
    //     确定性吞掉;豁免≠必回,只是把裁决权交还心流。
    // (3) 不再 recordGateNoAction —— 硬阈是 0 成本确定性判定,不需要冷却
    //     保护;记 no_action 会喂大指数退避(至 300s),一次静默繁殖出连串
    //     heart_cooldown_defer,defer 回放又撞硬阈 → 自放大吞消息环。
    const hardPassExempt =
      job.turnContext?.isDeferReplay === true || job.turnContext?.obligationStrong === true;
    if (!heartContinuation && !bypassEngagementHardPass && !hardPassExempt && engagement.budget <= HARD_PASS_BUDGET) {
      logger.info(
        {
          chatId: job.chatId, budget: engagement.budget.toFixed(2), factors: engagement.factors,
          isMultiAnchorTurn: job.turnContext?.isMultiAnchorTurn ?? false,
        },
        "Heart skipped (engagement budget), pass",
      );
      return { shouldReturn: true };
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
      botName: getBotDisplayName(),
      selfState,
      lastSpokeSecAgo,
      burstNote: [
        heartBurstIds.length > 1
          ? `(★ 是一波 ${heartBurstIds.length} 条连发的末尾,把整波当一个完整念头来评估)`
          : undefined,
        // 分人回复修复:多锚点回合里心流仍读实时上下文,可能看到兄弟组
        // 刚发的回复而理性地觉得"刚说过话了"从而 pass——这是给★这个人
        // 的独立回复,提醒它别因为回过别人就对这条也沉默。
        job.turnContext?.isMultiAnchorTurn
          ? '(本轮群里有好几个人各自问了不同的问题,你可能刚回过/正要回复其他人——这条★是另一个人的独立提问,不要因为刚回过别人就对这条也 pass)'
          : undefined,
        engagement.note ?? undefined,
      ].filter(Boolean).join('\n') || undefined,
      signal: job.turnContext.signal,
    });
    // 基础设施故障 ≠ 心流决策(gate 同哲学:llm_call_failed fail-open)。
    // 旧行为 fail-closed pass 终局吞回复(48h 1227 次 vs 总发送 387),且
    // 走下面 pass 分支 recordGateNoAction 毒化指数退避 → 连锁 defer →
    // resume 再撞坏链路,恶性循环。改为 MaiBot 不变量:任何"先不回"必须
    // 物化为会再触发的状态 —— defer 重评(预算内),预算耗尽回退 legacy
    // judge(judge 用 stepfun 主标签,与 heart 不同链)出真裁决。
    if (heart.act === 'pass' && heart.why === 'llm_failed') {
      if (hasDeferBudget(job.turnContext.deferCount)) {
        const rescheduled = await scheduleGateDeferReeval({
          chatId: job.chatId,
          entry: buildDeferEntry(job, formatted),
          deferCount: job.turnContext.deferCount ?? 0,
          retryAfterMs: 30_000,
          reason: 'heart_llm_failed_defer',
        }).catch(() => false);
        if (rescheduled) {
          logger.warn(
            { chatId: job.chatId, uid: formatted.uid },
            "Heart infra failure → timed re-eval scheduled",
          );
          return { shouldReturn: true };
        }
      }
      logger.warn(
        { chatId: job.chatId, deferCount: job.turnContext.deferCount },
        "Heart infra failure, defer budget exhausted → legacy judge fallback",
      );
      judgeResult = await judge({
        message: formatted, recentMessages,
        recentMessagesL2Fetcher: () => getRecent(job.chatId, e.JUDGE_WINDOW_SIZE * 3),
        botUid, botUsername: botIdentity.username, botNicknames: botIdentity.nicknames,
        chatId: job.chatId, groupActivity: { messagesLast5Min, messagesLast1Hour },
        burstHint,
        focus: focusLevel,
        // heart 回退时保持与心流路径同一套 L0 降级(P1 fix 2026-08-22 审查):
        // 否则"对话热度"规则在回退路径复活 → 同一条消息因 heart 健康与否判决不一致。
        demoteConversationalL0: true,
      });
    } else {
    // L2:念头入持续内心(reply/pass/wait 都是念头,沉默也是思考)
    import("./mind.js").then(({ noteThought }) => noteThought(job.chatId, heart.why)).catch((err) => logger.debug({ err, chatId: job.chatId }, 'noteThought failed (non-critical)'));
    if (heart.act === 'wait') {
      // 心流说"等TA说完" —— 复用 wait 基建(锚点暂存 + 真回访)。
      // review R3(被 verifier 误判 refuted,经代码对比确认真实):必须与
      // gate=wait 路径(:setWaitAnchor/:transitionToWait)一样保留
      // obligation 字段 + waitStartedAt,否则非 @ 问句的强债务在心流 wait
      // 回访时判不出保护性 wait,债务被静默丢弃(与 R2#3/#7 同 bug 类)。
      const waitSec = Math.max(e.TIMING_WAIT_MIN_SEC, 8);
      if (e.TURN_WAIT_RESUME_ENABLED) {
        try {
          await setWaitAnchor(job.chatId, {
            update: job.update, chatId: job.chatId,
            messageId: formatted.messageId, enqueuedAt: job.enqueuedAt, waitReplay: true,
            waitStartedAt: Date.now(),
            obligationId: job.turnContext.obligationId,
            obligationTargetUid: job.turnContext.obligationTargetUid,
            obligationStrong: job.turnContext.obligationStrong,
          }, waitSec + 120);
        } catch { /* non-critical */ }
      }
      await transitionToWait(
        job.chatId, waitSec, formatted.messageId, formatted.uid,
        job.turnContext.obligationId,
      );
      logger.info({ chatId: job.chatId, why: heart.why, triggerUid: formatted.uid }, "Pipeline complete (heart=wait)");
      return { shouldReturn: true };
    }
    if (heart.act === 'pass') {
      if (e.TURN_FOCUS_ENABLED) {
        import("../turn/focus.js").then(({ bumpFocus }) => bumpFocus(job.chatId, 'gate_no_action')).catch((err) => logger.debug({ err, chatId: job.chatId }, 'bumpFocus failed (non-critical)'));
      }
      await recordGateNoAction(job.chatId, formatted.uid).catch((err) => logger.debug({ err, chatId: job.chatId }, 'recordGateNoAction failed (non-critical)'));
      logger.info({ chatId: job.chatId, why: heart.why, triggerUid: formatted.uid }, "Pipeline complete (heart=pass, still present)");
      return { shouldReturn: true };
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
    } // ← heart 正常决策分支闭合(llm_failed 走上面的 defer/judge 兜底)
  }

  return { shouldReturn: false, judgeResult };
}
