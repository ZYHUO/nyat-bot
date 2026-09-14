// Uniform registration for Meta-side actions. The action itself still runs in
// the existing Meta host; this bridge records only bounded lifecycle facts so
// every Meta action has the same replay semantics as dispatch.taskToGroup.

import { createAgencyRun, dispatchAgencyRun } from "./agency-runtime.js";
import {
  createAnchoredAgencyEnvelope,
  type AgencyActionSemantics,
} from "./agency-action-semantics.js";
import type { AgencyAction } from "./agency.js";
import type { CognitiveScope } from "../shared/cognitive-scope.js";

export type MetaActionName =
  | "dispatch.taskToGroup"
  | "journal.tryWrite"
  | "journal.recent"
  | "todo.add"
  | "todo.list"
  | "todo.remove"
  | "agents.listStatus"
  | "conversations.query"
  | "memory.searchEntities";

export type MetaActionOutcome = "proposed" | "completed" | "skipped" | "failed";

export interface RegisterMetaActionInput {
  action: MetaActionName;
  chatId: number;
  anchorEventId?: string;
  triggerEventId?: string;
  obligationId?: string;
  outcome?: MetaActionOutcome;
  reason?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RegisteredMetaAction {
  target: `meta:${MetaActionName}`;
  scope: CognitiveScope;
  semantics: AgencyActionSemantics;
  idempotencyKey: string;
  correlationId: string;
}

export interface RecordMetaActionResult {
  ok: boolean;
  runId?: string;
  reused?: boolean;
  deferred?: boolean;
  reason?: string;
}

function validChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function bounded(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

function safeReason(value: string | undefined): string | undefined {
  const reason = bounded(value, 120);
  return reason && /^[A-Za-z0-9_.:-]+$/.test(reason) ? reason : undefined;
}

/** Pure contract used by all Meta action wrappers. */
export function registerMetaAction(
  input: RegisterMetaActionInput,
): RegisteredMetaAction | null {
  if (!input || !validChatId(input.chatId)) return null;
  const outcome = input.outcome ?? "completed";
  if (!["proposed", "completed", "skipped", "failed"].includes(outcome))
    return null;
  const target = `meta:${input.action}` as `meta:${MetaActionName}`;
  const triggerEventId = bounded(input.triggerEventId, 240);
  const anchorEventId = bounded(input.anchorEventId, 240) ?? triggerEventId;
  const obligationId =
    bounded(input.obligationId, 240) ?? `${target}:${input.chatId}`;
  const semantics: AgencyActionSemantics = {
    anchorEventId: anchorEventId ?? obligationId,
    triggerEventId: triggerEventId ?? anchorEventId ?? obligationId,
    obligationId,
    source: "meta",
  };
  const outcomeLabel = `${outcome}${safeReason(input.reason) ? `:${safeReason(input.reason)}` : ""}`;
  const idempotencyKey =
    `meta-action:${input.chatId}:${obligationId}:${outcomeLabel}`.slice(0, 240);
  return {
    target,
    scope: { visibility: "chat", chatId: input.chatId },
    semantics,
    idempotencyKey,
    correlationId: `meta:chat:${input.chatId}:obligation:${obligationId}`.slice(
      0,
      240,
    ),
  };
}

function observeAdapter(action: AgencyAction): {
  recorded: true;
  target: string;
} {
  return {
    recorded: true,
    target: action.type === "observe" ? action.target : "invalid-meta-action",
  };
}

/** Record a bounded Meta action fact. This never invokes the real Meta action. */
export async function recordMetaActionObservation(
  input: RegisterMetaActionInput,
): Promise<RecordMetaActionResult> {
  const registered = registerMetaAction(input);
  if (!registered)
    return { ok: false, reason: "invalid_meta_action_registration" };
  const metadata = Object.fromEntries(
    Object.entries(input.metadata ?? {})
      .slice(0, 12)
      .filter(
        ([key, value]) =>
          /^[A-Za-z][A-Za-z0-9_.:-]{0,48}$/.test(key) &&
          (value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"),
      ),
  );
  const action = {
    type: "observe" as const,
    target: registered.target,
    args: {
      outcome: input.outcome ?? "completed",
      ...(safeReason(input.reason) ? { reason: safeReason(input.reason) } : {}),
      ...metadata,
    },
  };
  const envelope = createAnchoredAgencyEnvelope({
    action,
    scope: registered.scope,
    source: "meta",
    anchorEventId: registered.semantics.anchorEventId,
    triggerEventId: registered.semantics.triggerEventId,
    obligationId: registered.semantics.obligationId,
    idempotencyKey: registered.idempotencyKey,
    correlationId: registered.correlationId,
    causationId: registered.semantics.anchorEventId,
    expectedOutcome: JSON.stringify({
      kind: "meta_action_observation",
      action: input.action,
      outcome: input.outcome ?? "completed",
      ...(safeReason(input.reason) ? { reason: safeReason(input.reason) } : {}),
    }).slice(0, 500),
    budget: { maxMs: 1_000, maxLlmCalls: 0, maxToolCalls: 0 },
  });
  if (!envelope.ok || !envelope.envelope)
    return { ok: false, reason: envelope.reason ?? "invalid_envelope" };
  const created = createAgencyRun(envelope.envelope);
  if (!created.ok || !created.run)
    return { ok: false, reason: created.reason ?? "agency_run_unavailable" };
  try {
    const dispatched = await dispatchAgencyRun(created.run.id, {
      observe: observeAdapter,
    });
    const run = dispatched.run ?? created.run;
    return {
      ok: true,
      runId: run.id,
      reused: created.reused === true,
      deferred: run.status === "waiting",
      ...(dispatched.reason ? { reason: dispatched.reason } : {}),
    };
  } catch {
    return {
      ok: false,
      runId: created.run.id,
      reused: created.reused === true,
      reason: "agency_observation_dispatch_failed",
    };
  }
}
