// Bridge legacy Reply deliveries into the durable Agency ledger.
//
// This module never sends anything and never dispatches an adapter. It only
// creates a speak run for an already delivered Telegram message, then settles
// it from the host receipt so rollout can measure real legacy outcomes first.

import {
  createAgencyRun,
  recordObservedAgencyOutcome,
} from "./agency-runtime.js";
import { createAnchoredAgencyEnvelope } from "./agency-action-semantics.js";
import type { JudgeAction, ReplyPath } from "../shared/types.js";

export interface LegacyReplyObservation {
  chatId: number;
  triggerMessageId: number;
  messageId: number;
  text: string;
  /** Durable Telegram event that caused the observed reply. */
  cognitiveAnchorEventId?: string;
  segment?: number;
  judgeAction?: JudgeAction;
  replyPath?: ReplyPath;
}

export interface LegacyReplyObservationResult {
  recorded: number;
  reused: number;
  skipped: number;
  failed: number;
  runIds: string[];
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function boundedText(value: string): string | null {
  const text = value.trim();
  return text ? text.slice(0, 4000) : null;
}

function boundedJson(value: unknown, max = 500): string {
  try {
    const json = JSON.stringify(value);
    return (typeof json === "string" ? json : "{}").slice(0, max);
  } catch {
    return "{}";
  }
}

/** Record each successful legacy Telegram delivery as an observed speak run. */
export function recordLegacyReplyObservations(
  observations: readonly LegacyReplyObservation[],
): LegacyReplyObservationResult {
  const result: LegacyReplyObservationResult = {
    recorded: 0,
    reused: 0,
    skipped: 0,
    failed: 0,
    runIds: [],
  };

  for (const observation of observations) {
    const text = boundedText(observation.text);
    if (
      !validId(observation.chatId) ||
      !Number.isSafeInteger(observation.triggerMessageId) ||
      observation.triggerMessageId <= 0 ||
      !Number.isSafeInteger(observation.messageId) ||
      observation.messageId <= 0 ||
      !text
    ) {
      result.skipped += 1;
      continue;
    }

    const envelope = createAnchoredAgencyEnvelope({
      action: { type: "speak", text },
      scope: { visibility: "chat", chatId: observation.chatId },
      idempotencyKey: `legacy-reply:${observation.chatId}:${observation.triggerMessageId}:${observation.messageId}`,
      correlationId: `legacy:chat:${observation.chatId}:message:${observation.triggerMessageId}:reply`,
      causationId:
        observation.cognitiveAnchorEventId?.trim() ||
        `telegram:${observation.chatId}:message:${observation.triggerMessageId}`,
      expectedOutcome: boundedJson({
        kind: "legacy_reply_delivery",
        triggerMessageId: observation.triggerMessageId,
        messageId: observation.messageId,
        segment: observation.segment ?? null,
        judgeAction: observation.judgeAction ?? null,
        replyPath: observation.replyPath ?? null,
        textChars: text.length,
      }),
      budget: { maxMs: 1_000, maxLlmCalls: 0, maxToolCalls: 0 },
      source: "legacy",
      anchorEventId:
        observation.cognitiveAnchorEventId ??
        `telegram:${observation.chatId}:message:${observation.triggerMessageId}`,
      triggerEventId: `telegram:${observation.chatId}:message:${observation.triggerMessageId}`,
      obligationId: `reply:${observation.chatId}:${observation.triggerMessageId}`,
    });
    if (!envelope.ok || !envelope.envelope) {
      result.failed += 1;
      continue;
    }

    const created = createAgencyRun(envelope.envelope);
    if (!created.ok || !created.run) {
      result.failed += 1;
      continue;
    }
    result.runIds.push(created.run.id);
    const settled = recordObservedAgencyOutcome({
      runId: created.run.id,
      status: "succeeded",
      result: { messageId: observation.messageId },
    });
    if (!settled.ok) {
      result.failed += 1;
      continue;
    }
    if (created.reused || settled.reason === "succeeded") result.reused += 1;
    else result.recorded += 1;
  }

  return result;
}
