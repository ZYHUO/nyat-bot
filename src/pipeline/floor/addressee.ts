import type { FormattedMessage } from "../../shared/types.js";
import { isMentioningSelf } from "../judge/rules.js";

export type AddresseeVerdict = "to_me" | "to_other" | "ambient" | "not_me";

export interface AddresseeResult {
  verdict: AddresseeVerdict;
  reason: string;
}

/** bot 在 floor 上：最近一条 bot 发言距今不超过 3 条消息。 */
function botDistance(recent: FormattedMessage[], botUid: number): number {
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (m.uid === botUid || m.role === "assistant") {
      return recent.length - 1 - i;
    }
  }
  return -1;
}

/** A↔B 双人连续互回 3 轮以上（近 6 条严格交替、恰好 2 个真人、无 bot）：禁止插话。 */
function isDuet(recent: FormattedMessage[]): boolean {
  if (recent.length < 6) return false;
  const window = recent.slice(-6);
  const uids = new Set<number>();
  for (let i = 0; i < window.length; i++) {
    const m = window[i]!;
    if (m.isBot || m.role !== "user") return false;
    uids.add(m.uid);
    if (i > 0 && m.uid === window[i - 1]!.uid) return false;
  }
  return uids.size === 2;
}

function mentionsOther(text: string, botUsername: string): boolean {
  const matches = text.match(/@(\w+)/g);
  if (!matches) return false;
  return matches.some((m) => m.toLowerCase() !== `@${botUsername.toLowerCase()}`);
}

export function classifyAddressee(
  msg: FormattedMessage,
  recent: FormattedMessage[],
  botUid: number,
  botUsername: string,
  botNicknames: string[],
  chatId?: number,
): AddresseeResult {
  const text = msg.textContent || msg.captionContent || "";

  // 1. 回复 bot → to_me
  if (msg.replyTo?.uid === botUid) return { verdict: "to_me", reason: "reply_to_self" };
  // 2. @bot / 叫名字 → to_me
  if (isMentioningSelf(text, botUsername, botNicknames)) {
    return { verdict: "to_me", reason: "mention_self" };
  }
  // 3. 转发 → not_me
  if (msg.isForwarded) return { verdict: "not_me", reason: "forwarded" };
  // 4. 其他 bot 的广播（没点我们）→ not_me
  if (msg.isBot && msg.uid !== botUid) return { verdict: "not_me", reason: "bot_message" };
  // 5. 回复别人 → to_other
  if (msg.replyTo && msg.replyTo.uid !== botUid) {
    return { verdict: "to_other", reason: "reply_to_other" };
  }
  // 6. @别人 → to_other（floor 被抢走也算这里）
  if (mentionsOther(text, botUsername)) return { verdict: "to_other", reason: "at_others" };
  // 7. 私聊 → to_me
  if (chatId !== undefined && chatId > 0) return { verdict: "to_me", reason: "private_chat" };
  // 8. 双人对聊 → not_me
  if (isDuet(recent)) return { verdict: "not_me", reason: "duet_no_interrupt" };
  // 9. bot 在 floor 上 → to_me
  const dist = botDistance(recent, botUid);
  if (dist >= 0 && dist <= 3) return { verdict: "to_me", reason: "floor_followup" };
  // 10. 其他 → ambient（只更新上下文，不进 judge）
  return { verdict: "ambient", reason: "ambient" };
}
