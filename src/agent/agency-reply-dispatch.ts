// Explicit authority-only Reply transport. The caller owns reply selection;
// this bridge owns durable speak execution and verifies the Telegram receipt.

import { env } from "../env.js";
import { createAgencyRun, dispatchAgencyRun } from "./agency-runtime.js";
import { createAnchoredAgencyEnvelope } from "./agency-action-semantics.js";
import { createTelegramAgencyDeliveryAdapters } from "./agency-delivery-adapter.js";
import type { AgencyRun } from "./agency-runtime.js";

export interface AgencyReplyDispatchInput {
  chatId: number;
  triggerMessageId: number;
  segment: number;
  text: string;
  replyToMessageId?: number;
  /** Durable cognitive event that caused this speak action. */
  cognitiveAnchorEventId?: string;
}

export interface AgencyReplyDispatchResult {
  /** Whether the explicit Agency transport was selected for this segment. */
  attempted: boolean;
  /** True only when a durable speak run and Telegram receipt both succeeded. */
  accepted: boolean;
  agencyRunId?: string;
  messageId?: number;
  reason?: string;
}

export function isAgencyReplyTransportEnabled(): boolean {
  try {
    const config = env();
    return (
      config.AGENCY_REPLY_TRANSPORT_ENABLED === true &&
      config.AGENCY_RUNTIME_MODE === "authority"
    );
  } catch {
    return false;
  }
}

function runReason(run: AgencyRun | undefined, fallback?: string): string {
  return (
    run?.error?.trim().slice(0, 240) ||
    fallback?.trim().slice(0, 240) ||
    (run ? `agency_run_${run.status}` : "agency_run_unavailable")
  );
}

function acceptedMessageId(run: AgencyRun | undefined): number | undefined {
  if (
    !run ||
    run.status !== "succeeded" ||
    !run.result ||
    typeof run.result !== "object" ||
    Array.isArray(run.result)
  ) {
    return undefined;
  }
  const messageId = (run.result as Record<string, unknown>)["messageId"];
  return typeof messageId === "number" &&
    Number.isSafeInteger(messageId) &&
    messageId > 0
    ? messageId
    : undefined;
}

function validateInput(input: AgencyReplyDispatchInput): string | undefined {
  if (!input || typeof input !== "object") return "invalid_reply_input";
  if (!Number.isSafeInteger(input.chatId) || input.chatId === 0)
    return "scoped_chat_required";
  if (
    !Number.isSafeInteger(input.triggerMessageId) ||
    input.triggerMessageId <= 0
  )
    return "invalid_trigger_message_id";
  if (
    !Number.isSafeInteger(input.segment) ||
    input.segment < 0 ||
    input.segment > 999
  )
    return "invalid_reply_segment";
  if (typeof input.text !== "string" || !input.text.trim())
    return "empty_reply_text";
  if (input.text.trim().length > 4000) return "reply_text_too_long";
  if (
    input.replyToMessageId !== undefined &&
    (!Number.isSafeInteger(input.replyToMessageId) ||
      input.replyToMessageId <= 0)
  ) {
    return "invalid_reply_to_message_id";
  }
  if (
    input.cognitiveAnchorEventId !== undefined &&
    (typeof input.cognitiveAnchorEventId !== "string" ||
      !input.cognitiveAnchorEventId.trim() ||
      input.cognitiveAnchorEventId.trim().length > 240)
  ) {
    return "invalid_cognitive_anchor_event_id";
  }
  return undefined;
}

/**
 * Submit one canonical Reply text segment through Agency. Disabled and
 * non-authority modes never create a run or construct a Telegram adapter.
 */
export async function dispatchReplyViaAgency(
  input: AgencyReplyDispatchInput,
): Promise<AgencyReplyDispatchResult> {
  if (!isAgencyReplyTransportEnabled()) {
    return {
      attempted: false,
      accepted: false,
      reason: "agency_reply_transport_disabled",
    };
  }
  const invalid = validateInput(input);
  if (invalid) return { attempted: true, accepted: false, reason: invalid };

  const text = input.text.trim();
  const idempotencyKey = `agency-reply:${input.chatId}:${input.triggerMessageId}:${input.segment}`;
  const envelope = createAnchoredAgencyEnvelope({
    action: {
      type: "speak",
      text,
      ...(input.replyToMessageId !== undefined
        ? { replyToMessageId: input.replyToMessageId }
        : {}),
    },
    scope: { visibility: "chat", chatId: input.chatId },
    idempotencyKey,
    correlationId: `reply:${input.chatId}:${input.triggerMessageId}`,
    causationId:
      input.cognitiveAnchorEventId?.trim() ||
      `telegram:${input.chatId}:message:${input.triggerMessageId}`,
    expectedOutcome: `Telegram speak receipt chat=${input.chatId} trigger=${input.triggerMessageId} segment=${input.segment} chars=${text.length}`,
    budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
    source: "reply",
    anchorEventId:
      input.cognitiveAnchorEventId ??
      `telegram:${input.chatId}:message:${input.triggerMessageId}`,
    triggerEventId: `telegram:${input.chatId}:message:${input.triggerMessageId}`,
    obligationId: `reply:${input.chatId}:${input.triggerMessageId}`,
  });
  if (!envelope.ok || !envelope.envelope) {
    return {
      attempted: true,
      accepted: false,
      reason: envelope.reason ?? "invalid_agency_envelope",
    };
  }

  const created = createAgencyRun(envelope.envelope);
  if (!created.ok || !created.run) {
    return {
      attempted: true,
      accepted: false,
      reason: created.reason ?? "agency_run_unavailable",
    };
  }

  let dispatched;
  try {
    dispatched = await dispatchAgencyRun(
      created.run.id,
      createTelegramAgencyDeliveryAdapters(),
    );
  } catch {
    return {
      attempted: true,
      accepted: false,
      agencyRunId: created.run.id,
      reason: "agency_dispatch_failed",
    };
  }
  const run = dispatched.run ?? created.run;
  const messageId = acceptedMessageId(run);
  if (!dispatched.ok || messageId === undefined) {
    return {
      attempted: true,
      accepted: false,
      agencyRunId: run.id,
      reason:
        messageId === undefined
          ? runReason(run, dispatched.reason)
          : (dispatched.reason ?? "agency_dispatch_rejected"),
    };
  }
  return {
    attempted: true,
    accepted: true,
    agencyRunId: run.id,
    messageId,
  };
}
