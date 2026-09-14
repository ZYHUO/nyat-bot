// Explicit CodeAct transport bridge for the main dispatch host.
//
// The bridge is intentionally authority-only. Shadow/advisory/canary keep
// using the legacy queue path, while an explicitly enabled authority rollout
// fails closed instead of bypassing Agency when the durable run cannot be
// accepted.

import { env } from "../env.js";
import { createAgencyRun, dispatchAgencyRun } from "./agency-runtime.js";
import { createAnchoredAgencyEnvelope } from "./agency-action-semantics.js";
import { createCodeActAgencyActAdapters } from "./agency-act-adapter.js";
import type { AgencyRun } from "./agency-runtime.js";
import type { DispatchTask } from "../meta/types.js";

export interface AgencyCodeActDispatchResult {
  /** Whether this explicit transport was selected for the task. */
  attempted: boolean;
  /** True only when the Agency host returned a durable accepted task receipt. */
  accepted: boolean;
  agencyRunId?: string;
  taskId?: string;
  reason?: string;
}

function transportEnabled(): boolean {
  try {
    const config = env();
    return (
      config.AGENCY_CODEACT_TRANSPORT_ENABLED === true &&
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

function acceptedTaskId(run: AgencyRun | undefined): string | undefined {
  if (
    !run ||
    run.status !== "succeeded" ||
    !run.result ||
    typeof run.result !== "object" ||
    Array.isArray(run.result)
  ) {
    return undefined;
  }
  const taskId = (run.result as Record<string, unknown>)["taskId"];
  return typeof taskId === "string" && taskId.trim()
    ? taskId.trim()
    : undefined;
}

/**
 * Submit a CodeAct task through Agency when the explicit authority transport
 * flag is enabled. No queue or Redis connection is touched otherwise.
 */
export async function dispatchCodeActTaskViaAgency(
  task: DispatchTask,
): Promise<AgencyCodeActDispatchResult> {
  if (!transportEnabled()) {
    return {
      attempted: false,
      accepted: false,
      reason: "agency_codeact_transport_disabled",
    };
  }
  if (
    !task ||
    typeof task.id !== "string" ||
    !task.id.trim() ||
    task.id.trim().length > 120
  ) {
    return { attempted: true, accepted: false, reason: "invalid_task_id" };
  }
  if (!Number.isSafeInteger(task.chatId) || task.chatId === 0) {
    return { attempted: true, accepted: false, reason: "scoped_chat_required" };
  }
  if (!task.contentDirection?.trim()) {
    return { attempted: true, accepted: false, reason: "empty_task_goal" };
  }
  if (
    task.cognitiveAnchorEventId !== undefined &&
    (typeof task.cognitiveAnchorEventId !== "string" ||
      !task.cognitiveAnchorEventId.trim() ||
      task.cognitiveAnchorEventId.trim().length > 240)
  ) {
    return {
      attempted: true,
      accepted: false,
      reason: "invalid_cognitive_anchor_event_id",
    };
  }

  const envelope = createAnchoredAgencyEnvelope({
    action: {
      type: "act",
      goal: task.contentDirection.trim().slice(0, 2000),
      taskId: task.id.trim(),
    },
    scope: { visibility: "task", chatId: task.chatId, taskId: task.id.trim() },
    idempotencyKey: `agency-codeact:${task.id.trim()}`,
    correlationId: `codeact:${task.id.trim()}`,
    causationId:
      task.cognitiveAnchorEventId?.trim() || `task:${task.id.trim()}`,
    expectedOutcome: `CodeAct queue accepted task ${task.id.trim()}`,
    budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
    source: "codeact",
    anchorEventId: task.cognitiveAnchorEventId ?? `task:${task.id.trim()}`,
    triggerEventId: task.cognitiveAnchorEventId ?? `task:${task.id.trim()}`,
    obligationId: `task:${task.id.trim()}`,
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
      createCodeActAgencyActAdapters(task),
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
  const acceptedId = acceptedTaskId(run);
  if (acceptedId !== task.id.trim()) {
    return {
      attempted: true,
      accepted: false,
      agencyRunId: run.id,
      reason: acceptedId
        ? "agency_task_id_mismatch"
        : runReason(run, dispatched.reason),
    };
  }
  return {
    attempted: true,
    accepted: true,
    agencyRunId: run.id,
    taskId: acceptedId,
  };
}
