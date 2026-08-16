// ────────────────────────────────────────
// L0 本地规则引擎 (0-5ms)
// ────────────────────────────────────────

import { resolveReplyPath } from "../../shared/types.js";
import type {
  FormattedMessage,
  JudgeResult,
  JudgeAction,
} from "../../shared/types.js";

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
    level: "L0_RULE",
    rule,
    latencyMs: 0,
  };
}

export function isMentioningSelf(
  text: string,
  botUsername: string,
  botNicknames: string[],
): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(`@${botUsername.toLowerCase()}`)) return true;
  for (const nick of botNicknames) {
    if (!nick) continue;
    const nickLower = nick.toLowerCase();
    if (!nickLower) continue;
    if (/[a-z0-9_]/i.test(nickLower)) {
      const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(nickLower)}([^\\p{L}\\p{N}_]|$)`, 'iu');
      if (pattern.test(lower)) return true;
      continue;
    }
    if (lower.includes(nickLower)) return true;
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

const STICKER_DISLIKE_PATTERN =
  /不喜欢|换一个|丑|难看|什么鬼|别发(?:贴纸|表情|这个|这种)|不要.*?(?:贴纸|表情)|不好看|恶心|太丑|好丑|不可爱|不合适|发错/;
export function looksLikeStickerDislike(text: string): boolean {
  return STICKER_DISLIKE_PATTERN.test(text);
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
    lastBotReplyIndex,
  } = ctx;
  const text = msg.textContent || msg.captionContent || "";

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
    // mute/unmute/remember/forget 的关键词触发已下线 —— 改由回复前的 LLM 指令分类
    // (directive.ts,CONTROL_DIRECTIVE_ENABLED)结合上下文听懂,静默执行 + emoji ack。
    if (looksLikeStickerDislike(text)) {
      return makeResult("REPLY", "sticker_dislike");
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
    // mute/unmute/记住/忘掉 关键词触发已下线 → directive.ts(回复前 LLM 指令分类)。
    return makeResult("REPLY", "mention_self", { skipPathResolution: true });
  }

  // 5. Forwarded message → IGNORE
  if (msg.isForwarded) {
    return makeResult("IGNORE", "forwarded");
  }

  // 5.5 Private chat → always REPLY (chatId > 0 = private)。记住/忘掉等指令改由
  // directive.ts(回复前 LLM 分类)处理,不再走关键词。
  if (ctx.chatId > 0) {
    return makeResult("REPLY", "private_chat", { skipPathResolution: true });
  }

  // 6. 热群：不再用概率跳过（纯 LLM 驱动原则 2026-08-06）——
  //    该不该插话交给 Heart LLM 决定（Heart prompt 自带"群很活跃时克制"人格）。
  //    fallthrough → L1/L2 → Heart。

  // 7. 纯 LLM 驱动（2026-08-06）：
  //    - active-conv engage 概率（0.6 随机继续聊）→ 删除，由 Heart LLM 判断
  //    - followup_to_bot 问题正则 → 删除，由 Heart LLM 判断
  //    原逻辑:bot 发言后短暂窗口内的自然跟进（无 @）会 REPLY/概率 engage。
  //    现:统一 fallthrough 到 Heart —— 模型读上下文决定接不接。

  // 8. 残留冷却（保留——成本保护 + 防复读，非意图引擎）：
  //    bot 刚说过话（最近 2 条内）且未命中上面任何协议性规则 → 保持安静。
  //    这是防"bot 自言自语刷屏"的基础设施，不是"该不该回"的意图判断。
  if (lastBotReplyIndex >= 0 && lastBotReplyIndex < 2) {
    return makeResult("IGNORE", "recent_reply");
  }

  // 9. @others → IGNORE（协议性：话题指向别人，bot 不该抢话）
  const atOtherMatch = text.match(/@(\w+)/g);
  if (atOtherMatch) {
    const mentionsOther = atOtherMatch.some(
      (m) => m.toLowerCase() !== `@${botUsername.toLowerCase()}`,
    );
    if (mentionsOther) {
      return makeResult("IGNORE", "at_others");
    }
  }

  // No rule matched → fallthrough to L1/L2 → Heart LLM decides.
  return null;
}
