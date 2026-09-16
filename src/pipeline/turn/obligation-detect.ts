import type { FormattedMessage } from "../../shared/types.js";
import type { DirectInteractionKind } from "../timing/direct-interaction.js";
import type { ReplyObligation, ReplyObligationKind } from "./obligation.js";
import { createReplyObligation } from "./obligation.js";

const QUESTION_RE = /[?？]$|^(为啥|为什么|咋|怎么|如何|能不能|可不可以|要不要|是不是|有没有|帮我|请问)/;

const CANCEL_PHRASES = ['算了', '不用了', '不用回', '别回了', '没事了', '当我没说', '不用看了'];

function normalizeTopicText(text: string): string {
  return text
    .toLowerCase()
    .replace(/@\w+/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim()
    .slice(0, 32);
}

export function deriveTopicKey(message: FormattedMessage): string | undefined {
  const base = (message.textContent || message.captionContent || '').trim();
  if (!base) return undefined;
  const normalized = normalizeTopicText(base);
  if (!normalized) return undefined;
  const replyPart = message.replyTo?.messageId ? `r${message.replyTo.messageId}:` : '';
  return `${replyPart}${normalized}`;
}

export function isObligationCancelMessage(message: FormattedMessage, active?: ReplyObligation): boolean {
  const text = (message.textContent || message.captionContent || '').trim();
  if (!text) return false;
  if (!CANCEL_PHRASES.some((phrase) => text.includes(phrase))) return false;
  if (!active) return false;
  const replyToAnchor =
    message.replyTo?.messageId !== undefined &&
    active.relatedMessageIds.includes(message.replyTo.messageId);
  if (replyToAnchor) return true;
  const messageTopicKey = deriveTopicKey(message);
  if (active.topicKey && messageTopicKey) {
    return (
      messageTopicKey === active.topicKey ||
      messageTopicKey.includes(active.topicKey.slice(0, 16)) ||
      active.topicKey.includes(messageTopicKey.slice(0, 16))
    );
  }
  return active.targetUid === message.uid && active.anchorUid === message.uid;
}


export function inferObligationKind(
  message: FormattedMessage,
  directKind: DirectInteractionKind | null,
): ReplyObligationKind | null {
  const text = (message.textContent || message.captionContent || '').trim();
  if (directKind === "private_chat") return "private_chat";
  if (directKind === "command") return "command";
  if (directKind === "reply_to_bot") return "reply_to_bot";
  if (directKind === "mention") return "mention";
  if (QUESTION_RE.test(text)) return "direct_question";
  return null;
}

export function detectReplyObligation(args: {
  chatId: number;
  message: FormattedMessage;
  directKind: DirectInteractionKind | null;
  activeObligation?: ReplyObligation;
}): ReplyObligation | null {
  const kind = inferObligationKind(args.message, args.directKind);
  if (!kind) return null;
  const strong = args.directKind !== null || kind === "direct_question";
  return createReplyObligation({
    chatId: args.chatId,
    message: args.message,
    kind,
    directInteraction: args.directKind !== null,
    mustReplyStrong: strong,
    reason: strong ? "direct_or_question" : "inferred",
    topicKey: deriveTopicKey(args.message),
  });
}

export function shouldAttachToObligation(
  active: ReplyObligation | undefined,
  message: FormattedMessage,
): boolean {
  if (!active) return false;
  if (active.targetUid === message.uid) return true;
  return active.topicKey !== undefined && active.topicKey.length > 0 && active.relatedMessageIds.includes(message.replyTo?.messageId ?? -1);
}
