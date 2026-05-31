// ────────────────────────────────────────
// L0 本地规则引擎 (0-5ms)
// ────────────────────────────────────────

import { resolveReplyPath, resolveReplyTier } from "../../shared/types.js";
import type {
  FormattedMessage,
  JudgeResult,
  JudgeAction,
} from "../../shared/types.js";
import {
  looksLikeExternalLookupRequest,
  looksLikeFollowupLookupRequest,
} from "../path-patterns.js";
import { env } from "../../env.js";

export interface RuleContext {
  message: FormattedMessage;
  recentMessages: FormattedMessage[];
  botUid: number;
  botUsername: string;
  botNicknames: string[];
  chatId: number;
  groupActivity: { messagesLast5Min: number; messagesLast1Hour: number };
  lastBotReplyIndex: number; // how many messages ago bot last replied (-1 = never)
  /** Epoch ms of last bot reply in this chat (from timing state-store). */
  lastBotReplyAt?: number;
  /** Count of recent non-bot human messages (pre-computed by judge.ts). */
  recentHumanMsgCount?: number;
}

const WHITELISTED_COMMANDS = new Set([
  "/checkin",
  "/help",
  "/status",
  "/stats",
  "/muteme",
  "/unmuteme",
  "/watch",
  "/unwatch",
  "/watches",
  "/game",
  "/feature",
  "/setdefault",
  "/cards",
  "/wish",
]);

function makeResult(
  action: JudgeAction,
  rule: string,
  opts?: { replyPath?: "direct" | "planned"; skipPathResolution?: boolean },
): JudgeResult {
  return {
    action,
    replyPath: opts?.skipPathResolution ? undefined : resolveReplyPath(action, opts?.replyPath),
    replyTier: resolveReplyTier(action),
    level: "L0_RULE",
    rule,
    latencyMs: 0,
  };
}

function isMentioningSelf(
  text: string,
  botUsername: string,
  botNicknames: string[],
): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(`@${botUsername.toLowerCase()}`)) return true;
  for (const nick of botNicknames) {
    if (nick && lower.includes(nick.toLowerCase())) return true;
  }
  return false;
}

function isReplyToSelf(msg: FormattedMessage, botUid: number): boolean {
  return msg.replyTo?.uid === botUid;
}

function getCommandName(text: string, botUsername: string): string | null {
  const match = text.match(/^\/(\w+)(?:@(\w+))?/);
  if (!match?.[1]) return null;
  // If @suffix is present, only handle if it targets our bot
  if (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())
    return null;
  return `/${match[1]}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBotAddress(
  text: string,
  botUsername: string,
  botNicknames: string[],
): string {
  let remaining = text.trim();
  const candidates = [`@${botUsername}`, ...botNicknames.filter(Boolean)].sort(
    (a, b) => b.length - a.length,
  );

  for (const candidate of candidates) {
    const pattern = new RegExp(
      `^${escapeRegex(candidate)}(?:[\\s,，:：!！。．、~～-]+)?`,
      "i",
    );
    if (pattern.test(remaining)) {
      remaining = remaining.replace(pattern, "").trim();
      break;
    }
  }

  return remaining;
}

const STICKER_DISLIKE_PATTERN =
  /不喜欢|换一个|丑|难看|什么鬼|别发(?:贴纸|表情|这个|这种)|不要.*?(?:贴纸|表情)|不好看|恶心|太丑|好丑|不可爱|不合适|发错/;

const REMEMBER_PATTERN =
  /帮[我俺]?记(?:住|一下|下来?)|记(?:住|下来?)(?:一下)?[：:，,]|keep\s+in\s+mind|记得(?:一下)?[：:，,]/i;

const VIEW_PREFS_PATTERN =
  /(?:你|帮我?)记(?:住|得)了(?:什么|哪些|啥)|(?:我的|我让你记的)(?:偏好|备忘)|我让你记的/i;
// 忘记偏好：要求"指令性"结构（帮我忘 / 忘掉:xxx / 别记了 等），
// 避免被自然语言里"忘掉你没脑子"等抱怨/感叹误触发。
const FORGET_PATTERN =
  /帮[我俺]?忘(?:掉|了|记)|忘(?:掉|了|记)(?:一下)?[：:，,]|^忘(?:掉|了|记)\s+[\u4e00-\u9fff\w]/i;
const FORGET_LITERAL_PATTERN =
  /^(?:别记了|不用记了|forget(?:\s+about\s+\S|:\s*\S))/i;

// 轻度禁言：只接受短句、直接命令式表达，避免“提到关键词”误触发
const MUTE_SOFT_PATTERN =
  /^(?:你\s*)?(?:闭嘴|住嘴|shut\s*up|stop\s*talking|不(?:许|准|要)\s*(?:说话|开口|出声)|别\s*(?:说话|出声)(?:我|了)?)\s*[!！。．,.，~～]*$/i;

// 强度禁言：同样要求明确命令式表达
const MUTE_HARD_PATTERN =
  /^(?:你\s*)?(?:不(?:许|准|要)\s*(?:回复|回答)(?:我|任何)|别\s*(?:回复|回答)(?:我|任何)(?:消息|话)?|完全不(?:要|许)\s*理我|stop\s*replying)\s*[!！。．,.，~～]*$/i;

// 定时禁言：「闭嘴 30 分钟」「安静 1 小时」等
const MUTE_TIMED_PATTERN =
  /(?:闭嘴|安静|别说话|别出声|shut\s*up|quiet)\s*(\d+)\s*(分钟|小时|min(?:utes?)?|h(?:ours?)?)/i;

// 解除禁言：可以说话了 / 解禁 等
const UNMUTE_PATTERN =
  /(?:可以|能|准)(?:说话|回复|回答|开口)了?|解除?禁言|解禁|you\s*can\s*(?:talk|speak|reply)\s*now/i;

export function looksLikeMuteSoftRequest(text: string): boolean {
  return MUTE_SOFT_PATTERN.test(text) && !MUTE_HARD_PATTERN.test(text);
}

export function looksLikeMuteHardRequest(text: string): boolean {
  return MUTE_HARD_PATTERN.test(text);
}

export function looksLikeUnmuteRequest(text: string): boolean {
  return UNMUTE_PATTERN.test(text);
}

/** Returns duration in ms if text is a timed mute request, otherwise null. */
export function parseMuteTimedRequest(text: string): number | null {
  const m = MUTE_TIMED_PATTERN.exec(text);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const isHour = unit.startsWith('小时') || unit.startsWith('h');
  return n * (isHour ? 3600_000 : 60_000);
}

export function looksLikeRememberRequest(text: string): boolean {
  return REMEMBER_PATTERN.test(text);
}

export function looksLikeViewPrefsRequest(text: string): boolean {
  return VIEW_PREFS_PATTERN.test(text);
}

export function looksLikeForgetRequest(text: string): boolean {
  return FORGET_PATTERN.test(text) || FORGET_LITERAL_PATTERN.test(text.trim());
}

export function looksLikeStickerDislike(text: string): boolean {
  return STICKER_DISLIKE_PATTERN.test(text);
}

// Reads like a question / prompt expecting an answer. Used so the bot doesn't go
// silent when someone answers a question it just asked (without a TG-reply / @).
const QUESTION_PATTERN =
  /[?？]|怎么|怎样|咋|什么|啥|为什么|为啥|干嘛|干啥|干什么|是不是|有没有|要不要|能不能|可不可以|行不行|去不去|对不对|好不好|多少|多久|多大|几[点个天号时]|哪[儿里位个]|谁|吗[\s~～!！。.…]*$|呢[\s~～!！。.…]*$/;
export function looksLikeQuestion(text: string): boolean {
  const t = (text || "").trim();
  return t.length > 0 && QUESTION_PATTERN.test(t);
}

/** True if the text @-mentions a user other than the bot. */
function mentionsOtherUser(text: string, botUsername: string): boolean {
  const matches = text.match(/@(\w+)/g);
  if (!matches) return false;
  return matches.some((m) => m.toLowerCase() !== `@${botUsername.toLowerCase()}`);
}

// ── Active-conversation window ───────────────────────────────────────────────
// Borrowed from MaiBot: after the bot itself speaks it stays "engaged" for a
// short window, so natural follow-ups (no @ / no TG-reply) are routed to the
// L1/L2 LLM judge instead of being hard-ignored by the recent_reply cooldown.
// It is the *LLM* that then decides — this never auto-replies. Deliberately
// disabled in hot chats (>= the hot_chat trigger) so it can't compound into spam.
export const ACTIVE_CONV_ENABLED = true;        // tunable — master switch
export const ACTIVE_CONV_MAX_INDEX = 4;         // tunable — bot among the last N messages == a live exchange
                                                //   (covers a brief interjection / addAssistant lag between turns)
export const ACTIVE_CONV_MAX_HOT_5MIN = 25;     // tunable — disable the relaxation at/above this burst rate
const ACTIVE_CONV_MIN_LEN = 2;                  // tunable — skip ultra-short noise (single emoji / "?")
// When someone speaks right after the bot and neither side asked a question, the bot
// continues the exchange this fraction of the time — MaiBot talk-frequency style:
// engages declarative follow-ups "适时" without replying to literally everything. The
// rest fall through to the L1/L2 judge. Dial up = chattier, down = quieter.
const ACTIVE_CONV_ENGAGE_RATE = 0.6;            // tunable — 0..1

/**
 * True when the bot is in a live exchange: it is one of the last few messages AND the
 * thread is calm (not a burst). Uses `lastBotReplyIndex` (reliably derived from recent
 * messages) — NOT a timing-store timestamp — so it works regardless of state writes.
 */
export function isActiveConv(lastBotReplyIndex: number, messagesLast5Min: number): boolean {
  if (!ACTIVE_CONV_ENABLED) return false;
  if (lastBotReplyIndex < 0 || lastBotReplyIndex >= ACTIVE_CONV_MAX_INDEX) return false;
  return messagesLast5Min < ACTIVE_CONV_MAX_HOT_5MIN;
}

export function evaluateRules(ctx: RuleContext): JudgeResult | null {
  const {
    message: msg,
    botUid,
    botUsername,
    botNicknames,
    groupActivity,
    lastBotReplyIndex,
  } = ctx;
  const text = msg.textContent || msg.captionContent || "";
  // Recent message texts for context-aware URL detection (last 3 non-bot messages)
  const recentTexts = ctx.recentMessages
    .slice(-3)
    .map((m) => m.textContent || m.captionContent || "")
    .filter(Boolean);

  // 1. Bot message — allow bot-to-bot conversations with round limits
  if (msg.isBot && msg.uid !== botUid) {
    // Only consider replying if bot mentions us or replies to us
    if (
      !isMentioningSelf(text, botUsername, botNicknames) &&
      !isReplyToSelf(msg, botUid)
    ) {
      return makeResult("IGNORE", "bot_message");
    }

    // Count our own recent replies to estimate bot-to-bot rounds
    // Only count our messages (role=assistant) as "rounds participated"
    // Note: addAssistant() runs after sending, so the latest reply may not yet be in recentMessages.
    // Using threshold 8 (not 10) to compensate for 1-2 round delay.
    let ourRecentReplies = 0;
    for (let i = ctx.recentMessages.length - 1; i >= 0; i--) {
      const m = ctx.recentMessages[i]!;
      if (m.role === "assistant") {
        ourRecentReplies++;
      } else if (m.isBot) {
        // Other bot message — keep counting if interleaved
        continue;
      } else {
        break;
      }
    }

    // Max 8 rounds of our replies (net effective max ~10 with write delay)
    // Prompt encourages natural wind-down at round 6-7
    if (ourRecentReplies >= 8) {
      return makeResult("IGNORE", "bot_fatigue");
    }
    return makeResult("REPLY", "bot_mentions_self");
  }

  // 2. Reply to self → REPLY
  if (isReplyToSelf(msg, botUid)) {
    if (ctx.chatId < 0 && looksLikeMuteHardRequest(text)) {
      return makeResult("REPLY", "mute_hard_request");
    }
    if (ctx.chatId < 0 && looksLikeMuteSoftRequest(text)) {
      return makeResult("REPLY", "mute_soft_request");
    }
    if (ctx.chatId < 0 && parseMuteTimedRequest(text) !== null) {
      return makeResult("REPLY", "mute_timed_request");
    }
    if (ctx.chatId < 0 && looksLikeUnmuteRequest(text)) {
      return makeResult("REPLY", "unmute_request");
    }
    if (looksLikeStickerDislike(text)) {
      return makeResult("REPLY", "sticker_dislike");
    }
    if (looksLikeRememberRequest(text)) {
      return makeResult("REPLY", "remember_request");
    }
    if (looksLikeViewPrefsRequest(text)) {
      return makeResult("REPLY", "view_prefs_request");
    }
    if (looksLikeForgetRequest(text)) {
      return makeResult("REPLY", "forget_request");
    }
    if (looksLikeFollowupLookupRequest(msg, botUid)) {
      return makeResult("REPLY", "reply_to_self_followup_lookup", {
        replyPath: "planned",
      });
    }
    if (looksLikeExternalLookupRequest(text, recentTexts)) {
      return makeResult("REPLY", "reply_to_self_lookup", {
        replyPath: "planned",
      });
    }
    return makeResult("REPLY", "reply_to_self", { skipPathResolution: true });
  }

  // 3. Slash commands — only if directed at us (no @suffix, or @our_bot)
  const cmd = getCommandName(text, botUsername);
  if (cmd) {
    if (cmd === "/muteme") {
      return makeResult("REPLY", "self_mute_request");
    }
    if (cmd === "/unmuteme") {
      return makeResult("REPLY", "self_unmute_request");
    }
    if (WHITELISTED_COMMANDS.has(cmd)) {
      return makeResult("REPLY", "whitelisted_command");
    }
    return makeResult("IGNORE", "unknown_command");
  }

  // 4. Direct @self or nickname mention → REPLY
  if (isMentioningSelf(text, botUsername, botNicknames)) {
    const addressedText = stripLeadingBotAddress(
      text,
      botUsername,
      botNicknames,
    );
    if (ctx.chatId < 0 && looksLikeMuteHardRequest(addressedText)) {
      return makeResult("REPLY", "mute_hard_request");
    }
    if (ctx.chatId < 0 && looksLikeMuteSoftRequest(addressedText)) {
      return makeResult("REPLY", "mute_soft_request");
    }
    if (ctx.chatId < 0 && parseMuteTimedRequest(addressedText) !== null) {
      return makeResult("REPLY", "mute_timed_request");
    }
    if (ctx.chatId < 0 && looksLikeUnmuteRequest(addressedText)) {
      return makeResult("REPLY", "unmute_request");
    }
    if (looksLikeRememberRequest(text)) {
      return makeResult("REPLY", "remember_request");
    }
    if (looksLikeViewPrefsRequest(text)) {
      return makeResult("REPLY", "view_prefs_request");
    }
    if (looksLikeForgetRequest(text)) {
      return makeResult("REPLY", "forget_request");
    }
    if (looksLikeExternalLookupRequest(text, recentTexts)) {
      return makeResult("REPLY", "mention_self_lookup", {
        replyPath: "planned",
      });
    }
    return makeResult("REPLY", "mention_self", { skipPathResolution: true });
  }

  // 5. Forwarded message → IGNORE
  if (msg.isForwarded) {
    return makeResult("IGNORE", "forwarded");
  }

  // 5.1 Unmute fallback — even without @bot, let unmute through so muted users can escape
  if (looksLikeUnmuteRequest(text)) {
    return makeResult("REPLY", "unmute_request");
  }

  // 5.5 Private chat → always REPLY (chatId > 0 = private)
  if (ctx.chatId > 0) {
    // Check remember request in DM (normally only checked in reply_to_self/mention_self branches)
    if (looksLikeRememberRequest(text)) {
      return makeResult("REPLY", "remember_request");
    }
    if (looksLikeViewPrefsRequest(text)) {
      return makeResult("REPLY", "view_prefs_request");
    }
    if (looksLikeForgetRequest(text)) {
      return makeResult("REPLY", "forget_request");
    }
    return makeResult("REPLY", "private_chat", { skipPathResolution: true });
  }

  // 6. Hot chat — 概率降级而非直接沉默
  // 25-39条/5min：30% 跳过；≥40条：70% 跳过；≥60条：100% 跳过
  // Lowered thresholds vs before to allow bot to participate in active but not
  // overwhelming conversations
  if (groupActivity.messagesLast5Min >= 25) {
    const skip =
      groupActivity.messagesLast5Min >= 60 ? true :
      groupActivity.messagesLast5Min >= 40 ? Math.random() < 0.7 :
      Math.random() < 0.3;
    if (skip) {
      // Proactive engagement: when enabled, occasionally let hot_chat fall through to L1/L2
      const e = env();
      if (e.JUDGE_PROACTIVE_ENABLED) {
        const intervalOk =
          !ctx.lastBotReplyAt ||
          (Date.now() - ctx.lastBotReplyAt) >= e.JUDGE_PROACTIVE_MIN_INTERVAL_SEC * 1000;
        const enoughHumans =
          (ctx.recentHumanMsgCount ?? 0) >= e.JUDGE_PROACTIVE_MIN_RECENT_MSGS;
        if (Math.random() < e.JUDGE_PROACTIVE_RATE && intervalOk && enoughHumans) {
          return null; // fallthrough to L1/L2
        }
      }
      return makeResult('IGNORE', 'hot_chat');
    }
  }

  // 7. Active-conversation engagement + recent-reply cooldown.
  // When the bot is in a live exchange — it spoke within the last few messages
  // (ACTIVE_CONV_MAX_INDEX, which tolerates a brief interjection / addAssistant lag)
  // and the thread is calm — keep it engaged instead of going silent:
  //   • a question from EITHER side (bot just asked, or the user is asking) → REPLY;
  //   • a plain statement right after the bot → continue "适时" (engage a share);
  //   • everything else → defer to the L1/L2 judge.
  const calm = groupActivity.messagesLast5Min < ACTIVE_CONV_MAX_HOT_5MIN;
  const hasContent = text.trim().length >= ACTIVE_CONV_MIN_LEN;
  const inActiveExchange =
    ACTIVE_CONV_ENABLED &&
    lastBotReplyIndex >= 0 &&
    lastBotReplyIndex < ACTIVE_CONV_MAX_INDEX &&
    calm &&
    hasContent &&
    !mentionsOtherUser(text, botUsername);

  if (inActiveExchange) {
    const botLast = ctx.recentMessages[ctx.recentMessages.length - 1 - lastBotReplyIndex];
    const botLastText = botLast ? botLast.textContent || botLast.captionContent || "" : "";
    if (looksLikeQuestion(botLastText) || looksLikeQuestion(text)) {
      return makeResult("REPLY", "followup_to_bot", { skipPathResolution: true });
    }
    if (lastBotReplyIndex === 0 && Math.random() < ACTIVE_CONV_ENGAGE_RATE) {
      return makeResult("REPLY", "active_conv_engage", { skipPathResolution: true });
    }
    return null; // let L1/L2 decide instead of a hard ignore
  }

  // Residual cooldown: bot spoke in the last 2 messages but this didn't qualify as a
  // continuation (hot thread / @others / no real content) → stay quiet, don't dominate.
  if (lastBotReplyIndex >= 0 && lastBotReplyIndex < 2) {
    return makeResult("IGNORE", "recent_reply");
  }

  // 8. @others → IGNORE
  const atOtherMatch = text.match(/@(\w+)/g);
  if (atOtherMatch) {
    const mentionsOther = atOtherMatch.some(
      (m) => m.toLowerCase() !== `@${botUsername.toLowerCase()}`,
    );
    if (mentionsOther) {
      return makeResult("IGNORE", "at_others");
    }
  }

  // No rule matched → pass to L1
  return null;
}
