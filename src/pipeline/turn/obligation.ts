import { randomUUID } from "node:crypto";
import type { FormattedMessage } from "../../shared/types.js";

export type ReplyObligationKind =
  | "direct_question"
  | "mention"
  | "reply_to_bot"
  | "private_chat"
  | "command"
  | "judge_reply"
  | "wait_resume"
  | "unanswered_revisit";

export type ReplyObligationState =
  | "pending"
  | "active"
  | "waiting"
  | "fulfilled"
  | "dropped"
  | "superseded";

export interface ReplyObligation {
  id: string;
  chatId: number;
  anchorMessageId: number;
  anchorUid: number;
  anchorFullName: string;
  anchorUsername?: string;
  targetUid: number;
  targetFullName: string;
  targetUsername?: string;
  kind: ReplyObligationKind;
  state: ReplyObligationState;
  priority: number;
  topicKey?: string;
  topicSummary?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  waitUntil?: number;
  reason?: string;
  directInteraction: boolean;
  mustReplyStrong: boolean;
  relatedMessageIds: number[];
  triggerUids: number[];
  supersededBy?: string;
}

export interface CreateObligationInput {
  chatId: number;
  message: FormattedMessage;
  kind: ReplyObligationKind;
  reason?: string;
  directInteraction: boolean;
  mustReplyStrong: boolean;
  priority?: number;
  topicKey?: string;
  topicSummary?: string;
  triggerUid?: number;
}

export interface ObligationSelectionResult {
  active?: ReplyObligation;
  contenders: ReplyObligation[];
}

export function createReplyObligation(input: CreateObligationInput): ReplyObligation {
  const now = Date.now();
  const priority = input.priority ?? defaultPriorityForKind(input.kind, input.mustReplyStrong);
  const triggerUid = input.triggerUid ?? input.message.uid;
  return {
    id: randomUUID(),
    chatId: input.chatId,
    anchorMessageId: input.message.messageId,
    anchorUid: input.message.uid,
    anchorFullName: input.message.fullName,
    anchorUsername: input.message.username || undefined,
    targetUid: input.message.uid,
    targetFullName: input.message.fullName,
    targetUsername: input.message.username || undefined,
    kind: input.kind,
    state: "pending",
    priority,
    topicKey: input.topicKey,
    topicSummary: input.topicSummary,
    createdAt: now,
    updatedAt: now,
    reason: input.reason,
    directInteraction: input.directInteraction,
    mustReplyStrong: input.mustReplyStrong,
    relatedMessageIds: [input.message.messageId],
    triggerUids: [triggerUid],
  };
}

export function defaultPriorityForKind(kind: ReplyObligationKind, strong: boolean): number {
  if (strong) return 100;
  switch (kind) {
    case "private_chat":
    case "command":
    case "mention":
    case "reply_to_bot":
    case "direct_question":
      return 95;
    case "wait_resume":
      return 85;
    case "unanswered_revisit":
      return 70;
    case "judge_reply":
    default:
      return 60;
  }
}

export function sortObligations(obligations: ReplyObligation[]): ReplyObligation[] {
  return [...obligations].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.mustReplyStrong !== b.mustReplyStrong) return a.mustReplyStrong ? -1 : 1;
    if (a.directInteraction !== b.directInteraction) return a.directInteraction ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}
