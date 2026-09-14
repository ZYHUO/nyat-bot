// Metadata-only Agency observation for Meta decisions.
//
// Meta still owns the legacy queue until an explicit authority rollout. This
// bridge records the structured dispatch intent so shadow/canary analysis can
// compare proposals with host outcomes without persisting model directions or
// invoking a second queue/send side effect.

import { createAgencyRun, dispatchAgencyRun } from "./agency-runtime.js";
import { createAnchoredAgencyEnvelope } from "./agency-action-semantics.js";
import type { AgencyRunStatus } from "./agency-runtime.js";
import type { AgencyAction } from "./agency.js";
import type { AttentionLayer } from "../meta/types.js";

export interface RecordMetaDispatchObservationInput {
  chatId: number;
  layer: AttentionLayer;
  quoteMessageIds: readonly number[];
  relatedQuoteCount?: number;
  taskId?: string;
  targetUserId?: number;
  interrupt?: boolean;
  cognitiveAnchorEventId?: string;
  decision?: "proposed" | "blocked" | "skipped";
  decisionReason?: string;
}

export interface RecordMetaDispatchObservationResult {
  ok: boolean;
  runId?: string;
  status?: AgencyRunStatus;
  reused?: boolean;
  deferred?: boolean;
  reason?: string;
}

function validChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function validMessageId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validAnchor(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const anchor = value.trim();
  return anchor.length > 0 && anchor.length <= 240;
}

function boundedRelatedQuoteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(8, Math.max(0, Math.trunc(value)))
    : 0;
}

function safeDecisionReason(value: unknown): string {
  if (typeof value !== "string") return "unspecified";
  const reason = value.trim().slice(0, 120);
  return /^[A-Za-z0-9_.:-]+$/.test(reason) ? reason : "unspecified";
}

function observeAdapter(action: AgencyAction): {
  recorded: true;
  target: string;
} {
  return {
    recorded: true,
    target:
      action.type === "observe"
        ? action.target
        : "invalid-meta-observation-action",
  };
}

/** Persist one Meta dispatch proposal without retaining free-form model text. */
export async function recordMetaDispatchObservation(
  input: RecordMetaDispatchObservationInput,
): Promise<RecordMetaDispatchObservationResult> {
  if (!input || typeof input !== "object")
    return { ok: false, reason: "invalid_input" };
  if (!validChatId(input.chatId))
    return { ok: false, reason: "invalid_chat_id" };
  if (!["L0", "L1", "L1_CALLBACK", "L2"].includes(input.layer)) {
    return { ok: false, reason: "invalid_attention_layer" };
  }
  const quoteMessageIds = (
    Array.isArray(input.quoteMessageIds) ? input.quoteMessageIds : []
  )
    .filter(validMessageId)
    .slice(0, 8);
  if (!validAnchor(input.cognitiveAnchorEventId)) {
    return { ok: false, reason: "invalid_cognitive_anchor_event_id" };
  }
  if (
    input.targetUserId !== undefined &&
    (!Number.isSafeInteger(input.targetUserId) || input.targetUserId <= 0)
  ) {
    return { ok: false, reason: "invalid_target_user_id" };
  }

  const taskId =
    typeof input.taskId === "string"
      ? input.taskId.trim().slice(0, 120) || undefined
      : undefined;
  const relatedQuoteCount = boundedRelatedQuoteCount(input.relatedQuoteCount);
  const cognitiveAnchorEventId =
    typeof input.cognitiveAnchorEventId === "string"
      ? input.cognitiveAnchorEventId.trim()
      : undefined;
  const decision = input.decision ?? "proposed";
  if (!["proposed", "blocked", "skipped"].includes(decision)) {
    return { ok: false, reason: "invalid_dispatch_decision" };
  }
  if (quoteMessageIds.length === 0 && !taskId && !cognitiveAnchorEventId) {
    return { ok: false, reason: "missing_dispatch_anchor" };
  }
  const triggerMessageId = quoteMessageIds[0];
  const stableAnchor =
    triggerMessageId !== undefined
      ? `message:${triggerMessageId}`
      : taskId
        ? `task:${taskId}`
        : `anchor:${cognitiveAnchorEventId!.slice(0, 120)}`;
  const decisionReason = safeDecisionReason(input.decisionReason);
  const idempotencyKey =
    `meta-dispatch:${input.chatId}:${stableAnchor}:${input.layer}` +
    (decision === "proposed" ? "" : `:${decision}:${decisionReason}`);
  const correlationId =
    triggerMessageId !== undefined
      ? `meta:chat:${input.chatId}:message:${triggerMessageId}:dispatch`
      : taskId
        ? `meta:chat:${input.chatId}:task:${taskId}:dispatch`
        : `meta:chat:${input.chatId}:anchor:${cognitiveAnchorEventId!.slice(0, 120)}:dispatch`;
  const envelope = createAnchoredAgencyEnvelope({
    action: {
      type: "observe",
      target: "meta:dispatch.taskToGroup",
      args: {
        layer: input.layer,
        quoteMessageIds,
        relatedQuoteCount,
        interrupt: input.interrupt === true,
        decision,
        ...(decision !== "proposed" ? { decisionReason } : {}),
        ...(taskId ? { taskId } : {}),
        ...(input.targetUserId !== undefined
          ? { targetUserId: input.targetUserId }
          : {}),
      },
    },
    scope: taskId
      ? { visibility: "task", chatId: input.chatId, taskId }
      : { visibility: "chat", chatId: input.chatId },
    idempotencyKey,
    correlationId,
    causationId:
      cognitiveAnchorEventId ||
      (triggerMessageId !== undefined
        ? `telegram:${input.chatId}:message:${triggerMessageId}`
        : `meta:${stableAnchor}`),
    expectedOutcome: JSON.stringify({
      kind: "meta_dispatch_proposal",
      layer: input.layer,
      quoteMessageIds,
      relatedQuoteCount,
      decision,
      ...(decision !== "proposed" ? { decisionReason } : {}),
      ...(taskId ? { taskId } : {}),
    }),
    budget: { maxMs: 1_000, maxLlmCalls: 0, maxToolCalls: 0 },
    source: "meta",
    anchorEventId:
      input.cognitiveAnchorEventId ??
      `telegram:${input.chatId}:message:${triggerMessageId ?? input.taskId ?? "dispatch"}`,
    triggerEventId:
      triggerMessageId !== undefined
        ? `telegram:${input.chatId}:message:${triggerMessageId}`
        : undefined,
    obligationId: taskId ? `task:${taskId}` : `meta-dispatch:${stableAnchor}`,
  });
  if (!envelope.ok || !envelope.envelope) {
    return { ok: false, reason: envelope.reason ?? "invalid_envelope" };
  }

  const created = createAgencyRun(envelope.envelope);
  if (!created.ok || !created.run) {
    return { ok: false, reason: created.reason ?? "agency_run_unavailable" };
  }

  let dispatched;
  try {
    dispatched = await dispatchAgencyRun(created.run.id, {
      observe: observeAdapter,
    });
  } catch {
    return {
      ok: false,
      runId: created.run.id,
      status: created.run.status,
      reused: created.reused === true,
      reason: "agency_observation_dispatch_failed",
    };
  }
  const run = dispatched.run ?? created.run;
  return {
    ok: true,
    runId: run.id,
    status: run.status,
    reused: created.reused === true,
    deferred: run.status === "waiting",
    ...(dispatched.reason ? { reason: dispatched.reason } : {}),
  };
}
