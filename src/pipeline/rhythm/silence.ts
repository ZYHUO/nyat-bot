// ────────────────────────────────────────
// Silence — 一个说了算的沉默收敛 (H1.2)
// refractory / defer / talk-value / recent_reply 各说各话,
// 这里收成一个确定性函数:纯本地 0ms,无 LLM。
// 三条沉默律(真人直觉):
//   1. self_chase:bot 刚说完(<60s)且没人接 → 不追问(真人不追问)
//   2. hot_lurk:群正热聊(1min≥10条)且没点我 → 潜水
//   3. dead_chat:6h 没人说话且没点我 → 不挖坟
// 其他一律 fail-open(不沉默),点名永远不沉默(调用方保证)。
// ────────────────────────────────────────

export interface SilenceInput {
  recentMessages: Array<{ uid: number; timestamp: number }>;
  botUid: number;
  nowMs: number;
  lastBotReplyAtMs?: number;
  messagesLast1Min?: number;
  addressedToBot?: boolean;
}

export interface SilenceResult {
  silent: boolean;
  reason: "self_chase" | "hot_lurk" | "dead_chat" | "none";
}

const SELF_CHASE_MS = 60_000;
const HOT_PER_MIN = 10;
const DEAD_MS = 6 * 3600_000;

export function shouldStaySilent(input: SilenceInput): SilenceResult {
  const none: SilenceResult = { silent: false, reason: "none" };
  if (input.addressedToBot) return none;

  // 1. self_chase:bot 刚说完且之后无人接话
  if (input.lastBotReplyAtMs) {
    const sinceBot = input.nowMs - input.lastBotReplyAtMs;
    if (sinceBot >= 0 && sinceBot < SELF_CHASE_MS) {
      const botSec = Math.floor(input.lastBotReplyAtMs / 1000);
      const followed = input.recentMessages.some(
        (m) => m.uid !== input.botUid && m.timestamp > botSec,
      );
      if (!followed) return { silent: true, reason: "self_chase" };
    }
  }

  // 2. hot_lurk:正热聊且没点我
  if ((input.messagesLast1Min ?? 0) >= HOT_PER_MIN) {
    return { silent: true, reason: "hot_lurk" };
  }

  // 3. dead_chat:最后一条消息是 6h 以前
  if (input.recentMessages.length > 0) {
    const last = input.recentMessages[input.recentMessages.length - 1]!;
    if (input.nowMs - last.timestamp * 1000 > DEAD_MS) {
      return { silent: true, reason: "dead_chat" };
    }
  }

  return none;
}
