// ────────────────────────────────────────
// Bookkeeping stage — context save, memory write, activity/profile tracking,
// DM intercepts (verification / game input).
// Extracted from pipeline.ts (pure extraction, no logic changes).
// ────────────────────────────────────────

import type { ChatJob, FormattedMessage } from "../../shared/types.js";
import { addMessage } from "../context/manager.js";
import { recordMessage as recordActivity } from "../../tracking/activity.js";
import { getBotTracker } from "../../tracking/interaction.js";
import { tryGenerateDigest } from "../../tracking/bot-digest.js";
import {
  checkOutcome,
  generateReflection,
} from "../../tracking/outcome.js";
import { recordUserMessage } from "../../tracking/user-profile.js";
import { memorizeMessage } from "../../memory/chroma.js";
import { maybeReact } from "../reactions.js";
import { recordInteraction } from "../../tracking/social-graph.js";
import { getRedis } from "../../db/redis.js";
import { callWithFallback } from "../../ai/fallback.js";
import { sendMessage } from "../../bot/sender/telegram.js";
import { getBotUid } from "../../bot/bot.js";
import { env } from "../../env.js";
import { logger } from "../../shared/logger.js";
import { checkWatches } from "../../tracking/topic-watch.js";
import { recordMessage as recordStatMessage } from "../../tracking/stats.js";
import { bumpGatePendingCount } from "../timing/state-store.js";
import { playGame, hasActiveGame } from "../games/manager.js";
import { sender } from "../shared.js";

export interface BookkeepingResult {
  shouldAbort: boolean;
  reason?: string;
}

export async function runBookkeeping(ctx: {
  formatted: FormattedMessage;
  chatId: number;
  botUid: number;
  botIdentity: { username: string; nicknames: string[] };
  isWaitReplay: boolean;
  isDeferReplay: boolean;
  isDenoiseBot: boolean;
  timings: Record<string, number>;
  job: ChatJob;
}): Promise<BookkeepingResult> {
  const { formatted, job, botUid, botIdentity, isDenoiseBot, timings } = ctx;
  const e = env();

  // 3. Save to context
  const t2 = performance.now();
  await addMessage(job.chatId, formatted);
  timings["save"] = Math.round(performance.now() - t2);

  // P5-B: 工作记忆缓存回填（进程重启后 Redis 里的 scratch 重新进进程内缓存，
  // 供 buildMessages 同步读）。fire-and-forget，赶不上本条消息、赶下一条。
  void import('../../tracking/scratchpad.js')
    .then(({ warmScratchCache }) => warmScratchCache(job.chatId))
    .catch(() => undefined);

  // 3.1 Long-term memory write (fire-and-forget)
  memorizeMessage(job.chatId, formatted).catch((err) => {
    logger.debug({ err, chatId: job.chatId }, "Memory write failed (non-critical)");
  });

  // 3.1b Capture person aliases / 外号 from group messages (deterministic, sync, cheap)
  if (job.chatId < 0 && !formatted.isBot) {
    import("../../knowledge/person-aliases.js")
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
  // 30s 滑窗计满 5 条 → 一次廉价 LLM 判定是否集体故障 → 冒一句;判是 10min/
  // 判否 15min 冷却 + 作息/抑制门。注:已无关键词预过滤,任何消息都计数)。
  if (job.chatId < 0 && !formatted.isBot && env().NETWORK_BURST_ENABLED) {
    import("../games/network-burst.js")
      .then(({ maybeNetworkBurst }) => maybeNetworkBurst(job.chatId, formatted, botUid))
      .catch((err) => logger.debug({ err, chatId: job.chatId }, 'network-burst failed (non-critical)'));
  }

  // 3.1g「深想」— @bot 的硬技术问题 → 后台 mundo 深答补发(fire-and-forget,
  // 正常回复照常;只对直接问 + 廉价判定为硬技术触发;失败/回退/空则不补发)。
  if (job.chatId < 0 && !formatted.isBot && env().DEEP_THINK_ENABLED && env().MUNDO_ENABLED) {
    import("../deep-think.js")
      .then(({ maybeDeepThink }) => maybeDeepThink(job.chatId, job.update as never, formatted, {
        uid: botUid, username: botIdentity.username, nicknames: botIdentity.nicknames,
      }))
      .catch((err) => logger.debug({ err, chatId: job.chatId }, 'deep-think failed (non-critical)'));
  }

  // 3.34 First-DM onboarding (fire-and-forget) — once per user, then continue
  if (job.chatId > 0 && !formatted.isBot) {
    const redis = getRedis();
    const onboardKey = `xxb:dm:onboarded:${formatted.uid}`;
    redis.set(onboardKey, '1', 'NX').then(async (set) => {
      if (set === null) return; // already onboarded
      const { buildOnboardingText } = await import('../../bot/handlers/help.js');
      await sender.sendDirect(job.chatId, buildOnboardingText(), formatted.messageId).catch((err) => logger.debug({ err, chatId: job.chatId }, 'onboarding send failed (non-critical)'));
    }).catch((err) => logger.debug({ err }, 'Onboarding check failed (non-critical)'));
  }

  // 3.345 DM 好感(功能 B):记录私聊过(供睡前/起床 DM 资格)+ 停 @催pm +
  // flush 攒着的话。全程 fire-and-forget,不阻塞管线;flush 仅在有攒话时动工。
  if (job.chatId > 0 && !formatted.isBot) {
    void (async () => {
      try {
        const { markDmEver, markPmDmOpen } = await import('../../tracking/dm-state.js');
        markDmEver(formatted.uid);
        markPmDmOpen(formatted.uid);
        const { countDmPending } = await import('../../tracking/dm-pending.js');
        if (countDmPending(formatted.uid) > 0) {
          const { flushDmPendingOnInbound } = await import('../dm-proactive.js');
          await flushDmPendingOnInbound(formatted.uid);
        }
      } catch (err) {
        logger.debug({ err }, 'DM affinity inbound hook failed (non-critical)');
      }
    })();
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
      return { shouldAbort: true, reason: "verification intercept" };
    }
  }

  // 3.5 Record group activity
  recordActivity(job.chatId, formatted.messageId, formatted.uid).catch((err) => {
    logger.debug({ err, chatId: job.chatId }, "Activity tracking failed (non-critical)");
  });

  // 3.55 P1-C talk_value:攒消息计数(gate 真实评估/bot 回复时清零)。
  // 在 !isWaitReplay && !isDeferReplay 的入册块里 → defer/wait 回放不会重复计数。
  if (e.TIMING_GATE_ENABLED && !formatted.isBot) {
    bumpGatePendingCount(job.chatId).catch((err) => logger.debug({ err, chatId: job.chatId }, 'bumpGatePendingCount failed (non-critical)'));
  }

  // 3.51 Stats (fire-and-forget)
  if (!formatted.isBot) {
    try { recordStatMessage(job.chatId, formatted.uid); } catch (err) { logger.debug({ err, chatId: job.chatId }, 'recordStatMessage failed'); }
  }

  // 3.52 Topic watch notifications (fire-and-forget)
  if (job.chatId < 0 && !formatted.isBot && formatted.textContent) {
    try {
      const watchers = checkWatches(job.chatId, formatted.textContent, formatted.uid);
      for (const uid of watchers) {
        sendMessage(uid, `📢 有人聊到了你追踪的话题喵~`).catch((err) => logger.debug({ err, uid }, 'topic-watch notify failed (non-critical)'));
      }
    } catch (err) { logger.debug({ err, chatId: job.chatId }, 'Topic watch check failed'); }
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
    checkOutcome(job.chatId, formatted, botIdentity.username).then(({ needsReflection }) => {
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
      return { shouldAbort: true, reason: "game input interception" };
    }
  }

  return { shouldAbort: false };
}
