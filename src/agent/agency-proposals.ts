// Bridge Core/legacy judge proposals into the durable Agency runtime.
//
// A judge result does not contain an approved reply body, so this bridge never
// invents one. It records the decision as a bounded read-only `observe` action;
// the intended judge action remains in expectedOutcome for replay/audit.

import { env } from "../env.js";
import { createAgencyRun, dispatchAgencyRun } from "./agency-runtime.js";
import { createAnchoredAgencyEnvelope } from "./agency-action-semantics.js";
import type { AgencyRunStatus } from "./agency-runtime.js";
import type { AgencyAction } from "./agency.js";
import type { JudgeResult } from "../shared/types.js";

export interface RecordAgencyProposalInput {
  chatId: number;
  messageId: number;
  judgeResult: JudgeResult;
  proposalId?: string;
  /** Durable Telegram/cognitive event that caused the proposal. */
  cognitiveAnchorEventId?: string;
}

export interface RecordAgencyProposalResult {
  ok: boolean;
  runId?: string;
  status?: AgencyRunStatus;
  reused?: boolean;
  deferred?: boolean;
  reason?: string;
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function validAnchor(value: string | undefined): boolean {
  if (value === undefined) return true;
  const anchor = value.trim();
  return anchor.length > 0 && anchor.length <= 240;
}

function proposalTarget(input: RecordAgencyProposalInput): string {
  return `core:judge:${input.judgeResult.action}:message:${input.chatId}:${input.messageId}`.slice(
    0,
    500,
  );
}

function expectedOutcome(input: RecordAgencyProposalInput): string {
  return JSON.stringify({
    kind: "core_judge_proposal",
    action: input.judgeResult.action,
    replyPath: input.judgeResult.replyPath ?? null,
    level: input.judgeResult.level,
    rule: input.judgeResult.rule ?? null,
    confidence: input.judgeResult.confidence ?? null,
    messageId: input.messageId,
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
  }).slice(0, 500);
}

function observeAdapter(action: AgencyAction): {
  recorded: true;
  target: string;
} {
  // This adapter has no external capability. It only settles the host-owned
  // observation when advisory/canary/authority mode explicitly allows reads.
  return {
    recorded: true,
    target:
      action.type === "observe"
        ? action.target
        : "invalid-agency-proposal-action",
  };
}

/** Persist and policy-dispatch one Core judge proposal without fabricating output. */
export async function recordAgencyProposal(
  input: RecordAgencyProposalInput,
): Promise<RecordAgencyProposalResult> {
  if (!validId(input.chatId)) return { ok: false, reason: "invalid_chat_id" };
  if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0) {
    return { ok: false, reason: "invalid_message_id" };
  }
  if (!validAnchor(input.cognitiveAnchorEventId)) {
    return { ok: false, reason: "invalid_cognitive_anchor_event_id" };
  }

  const idempotencyKey = `core-proposal:${input.chatId}:${input.messageId}:${input.judgeResult.action}:${input.judgeResult.level}`;
  const envelope = createAnchoredAgencyEnvelope({
    action: { type: "observe", target: proposalTarget(input) },
    scope: { visibility: "chat", chatId: input.chatId },
    idempotencyKey,
    correlationId: `core:chat:${input.chatId}:message:${input.messageId}`,
    ...(input.cognitiveAnchorEventId?.trim()
      ? { causationId: input.cognitiveAnchorEventId.trim() }
      : input.proposalId
        ? { causationId: `core:proposal:${input.proposalId}` }
        : {}),
    expectedOutcome: expectedOutcome(input),
    budget: { maxMs: 1_000, maxLlmCalls: 0, maxToolCalls: 0 },
    source: "core",
    anchorEventId:
      input.cognitiveAnchorEventId ??
      `telegram:${input.chatId}:message:${input.messageId}`,
    triggerEventId: `telegram:${input.chatId}:message:${input.messageId}`,
    obligationId: input.proposalId
      ? `proposal:${input.proposalId}`
      : `message:${input.messageId}`,
  });
  if (!envelope.ok || !envelope.envelope)
    return { ok: false, reason: envelope.reason ?? "invalid_envelope" };

  const created = createAgencyRun(envelope.envelope);
  if (!created.ok || !created.run)
    return { ok: false, reason: created.reason ?? "agency_run_unavailable" };

  // The local stub below used to be the only adapter: it returned
  // `{recorded: true}` without reading anything, because the host had no real
  // implementation to give it. `runtimeAdaptersFromHost()` supplies the actual
  // observe/remember/correct/stop operations; the stub remains the fallback when
  // the feature is off, so behaviour is unchanged by default.
  const adapters = env().AGENCY_CONTROL_ADAPTERS_ENABLED
    ? (await import('./agency-host-adapters.js')).runtimeAdaptersFromHost()
    : { observe: observeAdapter };
  const dispatched = await dispatchAgencyRun(created.run.id, adapters);
  const run = dispatched.run ?? created.run;
  return {
    ok: true,
    runId: run.id,
    status: run.status,
    reused: created.reused,
    deferred: run.status === "waiting",
    ...(dispatched.reason ? { reason: dispatched.reason } : {}),
  };
}
