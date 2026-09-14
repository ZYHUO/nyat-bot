// Explicit authority-only wait transport. The caller persists its replay
// anchor; this bridge owns the durable wait run and timing receipt.

import { env } from "../env.js";
import { createAgencyRun, dispatchAgencyRun } from "./agency-runtime.js";
import { createAnchoredAgencyEnvelope } from "./agency-action-semantics.js";
import { createTimingAgencyWaitAdapters } from "./agency-wait-adapter.js";
import type { AgencyRun } from "./agency-runtime.js";

export type AgencyWaitSource =
  "heart" | "meta_heart" | "meta_timing" | "dispatch_gate" | "pipeline_gate";

export interface AgencyWaitDispatchInput {
  chatId: number;
  triggerMessageId: number;
  triggerUserId?: number;
  waitSec: number;
  reason: string;
  source: AgencyWaitSource;
  obligationId?: string;
  /** Durable cognitive event that caused this wait action. */
  cognitiveAnchorEventId?: string;
}

export interface AgencyWaitDispatchResult {
  attempted: boolean;
  accepted: boolean;
  agencyRunId?: string;
  waitUntil?: number;
  waitJobId?: string;
  reason?: string;
}

export function isAgencyWaitTransportEnabled(): boolean {
  try {
    const config = env();
    return (
      config.AGENCY_WAIT_TRANSPORT_ENABLED === true &&
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

function acceptedWait(
  run: AgencyRun | undefined,
): { waitUntil: number; waitJobId?: string } | undefined {
  if (
    !run ||
    run.status !== "succeeded" ||
    !run.result ||
    typeof run.result !== "object" ||
    Array.isArray(run.result)
  ) {
    return undefined;
  }
  const result = run.result as Record<string, unknown>;
  const waitUntil = result["waitUntil"];
  if (
    typeof waitUntil !== "number" ||
    !Number.isSafeInteger(waitUntil) ||
    waitUntil <= 0
  )
    return undefined;
  const waitJobId = result["waitJobId"];
  if (
    waitJobId !== undefined &&
    (typeof waitJobId !== "string" ||
      !waitJobId.trim() ||
      waitJobId.length > 240)
  ) {
    return undefined;
  }
  return {
    waitUntil,
    ...(waitJobId !== undefined ? { waitJobId: waitJobId.trim() } : {}),
  };
}

function validateInput(input: AgencyWaitDispatchInput): string | undefined {
  if (!input || typeof input !== "object") return "invalid_wait_input";
  if (!Number.isSafeInteger(input.chatId) || input.chatId === 0)
    return "scoped_chat_required";
  if (
    !Number.isSafeInteger(input.triggerMessageId) ||
    input.triggerMessageId <= 0
  )
    return "invalid_trigger_message_id";
  if (
    input.triggerUserId !== undefined &&
    (!Number.isSafeInteger(input.triggerUserId) || input.triggerUserId <= 0)
  )
    return "invalid_trigger_user_id";
  if (
    !Number.isFinite(input.waitSec) ||
    input.waitSec < 0 ||
    input.waitSec > 24 * 3600
  )
    return "invalid_wait_seconds";
  if (
    ![
      "heart",
      "meta_heart",
      "meta_timing",
      "dispatch_gate",
      "pipeline_gate",
    ].includes(input.source)
  ) {
    return "invalid_wait_source";
  }
  if (typeof input.reason !== "string" || !input.reason.trim())
    return "empty_wait_reason";
  if (input.reason.trim().length > 500) return "wait_reason_too_long";
  if (
    input.obligationId !== undefined &&
    (typeof input.obligationId !== "string" ||
      !input.obligationId.trim() ||
      input.obligationId.trim().length > 120)
  )
    return "invalid_obligation_id";
  if (
    input.cognitiveAnchorEventId !== undefined &&
    (typeof input.cognitiveAnchorEventId !== "string" ||
      !input.cognitiveAnchorEventId.trim() ||
      input.cognitiveAnchorEventId.trim().length > 240)
  )
    return "invalid_cognitive_anchor_event_id";
  return undefined;
}

/** Submit one wait decision through Agency and require the timing receipt. */
export async function dispatchWaitViaAgency(
  input: AgencyWaitDispatchInput,
): Promise<AgencyWaitDispatchResult> {
  if (!isAgencyWaitTransportEnabled()) {
    return {
      attempted: false,
      accepted: false,
      reason: "agency_wait_transport_disabled",
    };
  }
  const invalid = validateInput(input);
  if (invalid) return { attempted: true, accepted: false, reason: invalid };

  const waitSec = Math.floor(input.waitSec);
  const reason = input.reason.trim();
  const idempotencyKey = `agency-wait:${input.source}:${input.chatId}:${input.triggerMessageId}`;
  const envelope = createAnchoredAgencyEnvelope({
    action: { type: "wait", reason, waitSec },
    scope: { visibility: "chat", chatId: input.chatId },
    idempotencyKey,
    correlationId: `wait:${input.source}:${input.chatId}:${input.triggerMessageId}`,
    causationId:
      input.cognitiveAnchorEventId?.trim() ||
      `telegram:${input.chatId}:message:${input.triggerMessageId}`,
    expectedOutcome: `timing wait receipt chat=${input.chatId} trigger=${input.triggerMessageId} source=${input.source} seconds=${waitSec}`,
    budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
    source:
      input.source === "heart" || input.source === "meta_heart"
        ? "heart"
        : "timing",
    anchorEventId:
      input.cognitiveAnchorEventId ??
      `telegram:${input.chatId}:message:${input.triggerMessageId}`,
    triggerEventId: `telegram:${input.chatId}:message:${input.triggerMessageId}`,
    obligationId:
      input.obligationId ?? `wait:${input.chatId}:${input.triggerMessageId}`,
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
      createTimingAgencyWaitAdapters({
        anchorMessageId: input.triggerMessageId,
        ...(input.triggerUserId !== undefined
          ? { triggerUserId: input.triggerUserId }
          : {}),
        ...(input.obligationId !== undefined
          ? { obligationId: input.obligationId.trim() }
          : {}),
      }),
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
  const wait = acceptedWait(run);
  if (!dispatched.ok || !wait) {
    return {
      attempted: true,
      accepted: false,
      agencyRunId: run.id,
      reason: wait
        ? (dispatched.reason ?? "agency_dispatch_rejected")
        : runReason(run, dispatched.reason),
    };
  }
  return {
    attempted: true,
    accepted: true,
    agencyRunId: run.id,
    waitUntil: wait.waitUntil,
    ...(wait.waitJobId !== undefined ? { waitJobId: wait.waitJobId } : {}),
  };
}
