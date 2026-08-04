// ────────────────────────────────────────
// Pipeline shared state — sender singleton + judge-rule sets
// (extracted from pipeline.ts; pure data, no behavior)
// ────────────────────────────────────────

import { StreamingSender } from "../bot/sender/streaming.js";
import type { ChatJob, FormattedMessage } from "../shared/types.js";
import type { PendingEntry } from "./turn/types.js";

export const sender = new StreamingSender();

// review R3#5:gate 路径与心流路径的 defer 暂存条目曾各自手写、字段漂移过
// (R2#3/#7 就是心流那份漏了 obligation)。抽成单一构造点,新增字段只改这里,
// 两条 defer 路径永远同构。
export function buildDeferEntry(job: ChatJob, formatted: FormattedMessage): PendingEntry {
  return {
    update: job.update,
    chatId: job.chatId,
    messageId: formatted.messageId,
    enqueuedAt: job.enqueuedAt,
    obligationId: job.turnContext?.obligationId,
    obligationTargetUid: job.turnContext?.obligationTargetUid,
    obligationStrong: job.turnContext?.obligationStrong,
  };
}

export const TEMP_MUTE_CLEAR_RULES = new Set([
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  "mention_self",
  "mention_self_lookup",
]);

export const DIRECT_INTERACTION_RULES = new Set([
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  "mention_self",
  "mention_self_lookup",
  "whitelisted_command",
  "private_chat",
  // Active-conversation engagement: deliberate "this is for the bot" decisions —
  // don't let stale-reply suppression / the timing gate silence them.
  "followup_to_bot",
  "active_conv_engage",
  // G3 replan: engagement 是从被打断的那次 judge 接力来的(准 direct)。
  // 不在这里的话,replan 回复会被 stale-suppression 丢、指令层也不识别。
  "turn_replan",
]);

// Judge rules that mean "the bot was addressed" in a group — the gate for
// natural-language command invocation (DMs are always eligible).
export const ADDRESSED_RULES = new Set([
  "mention_self",
  "mention_self_lookup",
  "reply_to_self",
  "reply_to_self_lookup",
  "reply_to_self_followup_lookup",
  // G3 replan 锚点(打断 bot 的那条消息)继承点名语境 —— 否则锚点里的
  // 自然语言命令(帮我签到)在 replan 路径不会被 dispatch。
  "turn_replan",
]);
