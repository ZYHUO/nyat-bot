// ────────────────────────────────────────
// Judge 编排器 — L0 → L1 → L2 级联
// ────────────────────────────────────────

import type { FormattedMessage, JudgeResult } from "../../shared/types.js";
import type { RuleContext } from "./rules.js";
import { evaluateRules } from "./rules.js";
import { microJudge } from "./micro.js";
import { logger } from "../../shared/logger.js";
import { env } from "../../env.js";
import { getKnowledge } from "../../knowledge/manager.js";
import { getChatState } from "../timing/chat-runtime.js";

export interface JudgeInput {
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  recentMessagesL2Fetcher?: () => Promise<FormattedMessage[]>; // lazy fetch for L2 large window
  botUid: number;
  botUsername: string;
  botNicknames: string[];
  chatId: number;
  groupActivity: { messagesLast5Min: number; messagesLast1Hour: number };
}

function findLastBotReplyIndex(
  messages: FormattedMessage[],
  botUid: number,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && (msg.role === "assistant" || msg.uid === botUid)) {
      return messages.length - 1 - i;
    }
  }
  return -1;
}

function shouldAcceptL1Result(result: JudgeResult): boolean {
  const confidence = result.confidence ?? 0;

  if (result.action === "REPLY") return confidence > 0.8;
  if (result.action === "IGNORE") return confidence >= 0.5;
  if (result.action === "REJECT") return confidence > 0.8;
  return false;
}

export async function judge(input: JudgeInput): Promise<JudgeResult> {
  const totalStart = performance.now();

  // ── L0: Local rules (0-5ms) ──
  const e = env();

  // Pre-compute proactive engagement context (async, before sync evaluateRules)
  let lastBotReplyAt: number | undefined;
  let recentHumanMsgCount: number | undefined;
  if (e.JUDGE_PROACTIVE_ENABLED) {
    const timingState = await getChatState(input.chatId);
    lastBotReplyAt = timingState.lastBotReplyAt;
    recentHumanMsgCount = input.recentMessages.filter(
      (m) => !m.isBot && m.uid !== input.botUid && m.role !== 'assistant',
    ).length;
  }

  const ruleCtx: RuleContext = {
    message: input.message,
    recentMessages: input.recentMessages,
    botUid: input.botUid,
    botUsername: input.botUsername,
    botNicknames: input.botNicknames,
    chatId: input.chatId,
    groupActivity: input.groupActivity,
    lastBotReplyIndex: findLastBotReplyIndex(
      input.recentMessages,
      input.botUid,
    ),
    lastBotReplyAt,
    recentHumanMsgCount,
  };

  const l0Start = performance.now();
  const l0Result = evaluateRules(ruleCtx);
  if (l0Result) {
    l0Result.latencyMs = Math.round(performance.now() - l0Start);
    logger.debug(
      {
        rule: l0Result.rule,
        action: l0Result.action,
        replyPath: l0Result.replyPath,
        replyTier: l0Result.replyTier,
        ms: l0Result.latencyMs,
      },
      "L0 rule matched",
    );
    return l0Result;
  }

  let knowledgeForJudge = "";
  if (e.JUDGE_KNOWLEDGE_ENABLED) {
    knowledgeForJudge = getKnowledge(input.chatId, {
      permanent: e.JUDGE_KNOWLEDGE_PERMANENT,
      group: e.JUDGE_KNOWLEDGE_GROUP,
    });
  }

  // ── L1: Micro model (150-300ms) ──
  const l1Result = await microJudge(
    input.message,
    input.recentMessages,
    input.botUid,
    "judge",
    knowledgeForJudge,
    input.chatId,
  );
  if (shouldAcceptL1Result(l1Result)) {
    logger.debug(
      {
        action: l1Result.action,
        replyPath: l1Result.replyPath,
        replyTier: l1Result.replyTier,
        confidence: l1Result.confidence,
        ms: l1Result.latencyMs,
      },
      "L1 high confidence",
    );
    return l1Result;
  }

  // ── L2: Same as L1 but with M2_FAST and full context (Phase 1 simplified) ──
  const l2Messages = input.recentMessagesL2Fetcher
    ? await input.recentMessagesL2Fetcher()
    : input.recentMessages;
  const l2Result = await microJudge(
    input.message,
    l2Messages,
    input.botUid,
    "reply",
    knowledgeForJudge,
    input.chatId,
  );
  l2Result.level = "L2_AI";

  const totalMs = Math.round(performance.now() - totalStart);
  logger.debug(
    {
      action: l2Result.action,
      replyPath: l2Result.replyPath,
      replyTier: l2Result.replyTier,
      confidence: l2Result.confidence,
      l1Action: l1Result.action,
      l1ReplyPath: l1Result.replyPath,
      l1ReplyTier: l1Result.replyTier,
      l1Confidence: l1Result.confidence,
      totalMs,
    },
    "L2 judge complete",
  );

  return l2Result;
}
