// NyatOS Cognitive Kernel.
//
// The kernel is the small event-sourced boundary shared by Telegram, Meta,
// scheduler and tool adapters. It does not call a model or an executor. A
// model may propose an action, while the host remains responsible for scope,
// capability, idempotency and the receipt that closes the action.

import { randomUUID } from "node:crypto";
import {
  appendCognitiveEvent,
  getCognitiveEvent,
  listCognitiveEvents,
  type CognitiveEvent,
  type CognitiveEventSource,
  type CognitiveEventType,
} from "./cognitive-events.js";
import { env } from "../env.js";
import { scopeKey, type CognitiveScope } from "../shared/cognitive-scope.js";

export type KernelTriggerKind =
  | "telegram_message"
  | "telegram_edit"
  | "telegram_reaction"
  | "meta_attention"
  | "scheduler_tick"
  | "tool_receipt"
  | "host_observation"
  | "user_correction"
  | "internal";

export type KernelActionLane =
  | "social"
  | "perception"
  | "craft"
  | "care"
  | "reflection";

export type KernelActionKind =
  | "speak"
  | "wait"
  | "observe"
  | "work"
  | "repair"
  | "share"
  | "challenge"
  | "leave";

export type KernelActionStatus =
  | "candidate"
  | "deferred"
  | "accepted"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled";

export type KernelOutcomeStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "skipped"
  | "interrupted";

export interface KernelTriggerInput {
  scope: CognitiveScope;
  kind: KernelTriggerKind;
  source: Extract<CognitiveEventSource, "telegram" | "host" | "scheduler" | "tool" | "model">;
  /** An existing host event, such as message_received, that caused this turn. */
  anchorEventId?: string;
  correlationId?: string;
  dedupeKey?: string;
  occurredAt?: number;
  metadata?: Record<string, unknown>;
}

export interface KernelTriggerReceipt {
  event: CognitiveEvent;
  inserted: boolean;
}

export interface KernelActionPrediction {
  expectedEffect: string;
  watchFor: string[];
}

export interface ActionEnvelope {
  schema: "action_envelope.v1";
  id: string;
  scope: CognitiveScope;
  triggerEventId: string;
  frameEventId: string;
  lane: KernelActionLane;
  kind: KernelActionKind;
  payload: Record<string, unknown>;
  prediction?: KernelActionPrediction;
  budget: {
    maxAttempts: number;
    maxWallClockSec: number;
  };
  expiresAt?: number;
  status: KernelActionStatus;
  createdAt: number;
}

export interface KernelFrame {
  schema: "kernel_frame.v1";
  scope: CognitiveScope;
  scopeKey: string;
  correlationId: string;
  frameEventId?: string;
  triggerEventId?: string;
  asOf: number;
  eventIds: string[];
  triggerCount: number;
  observationCount: number;
  proposalCount: number;
  outcomeCount: number;
  latestTrigger?: {
    id: string;
    kind: string;
    occurredAt: number;
  };
  /** Full bounded envelopes needed to rehydrate a turn after a restart. */
  envelopes?: ActionEnvelope[];
  actions: Array<{
    id: string;
    kind: KernelActionKind;
    lane: KernelActionLane;
    status: KernelActionStatus;
    triggerEventId: string;
    createdAt: number;
  }>;
  outcomes: Array<{
    envelopeId: string;
    status: KernelOutcomeStatus;
    occurredAt: number;
    predictionError?: number;
  }>;
  unknowns: string[];
}

export interface OpenKernelFrameInput {
  scope: CognitiveScope;
  triggerEventId?: string;
  correlationId?: string;
  asOfEventId?: string;
  limit?: number;
}

export interface OpenKernelFrameResult {
  frame: KernelFrame;
  observedEventId?: string;
  inserted: boolean;
}

export interface ProposeKernelActionInput {
  scope: CognitiveScope;
  triggerEventId: string;
  frameEventId?: string;
  lane: KernelActionLane;
  kind: KernelActionKind;
  payload?: Record<string, unknown>;
  prediction?: KernelActionPrediction;
  budget?: Partial<ActionEnvelope["budget"]>;
  expiresAt?: number;
  idempotencyKey: string;
  correlationId?: string;
}

export interface KernelActionReceipt {
  envelope: ActionEnvelope;
  eventId: string;
  inserted: boolean;
}

export interface RecordKernelOutcomeInput {
  scope: CognitiveScope;
  envelopeId: string;
  status: KernelOutcomeStatus;
  receipt?: Record<string, unknown>;
  occurredAt?: number;
  predictionError?: number;
  reason?: string;
  correlationId?: string;
  causationId?: string;
}

export interface KernelOutcomeReceipt {
  eventId: string;
  inserted: boolean;
}

const KERNEL_EVENT_TYPES: ReadonlySet<CognitiveEventType> = new Set([
  "cognitive_trigger",
  "cognitive_frame_observed",
  "action_envelope_proposed",
  "action_envelope_transition",
  "action_envelope_outcome",
]);
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_ACTION_PAYLOAD_BYTES = 4 * 1024;
const MAX_ARRAY_ITEMS = 24;
const MAX_STRING_CHARS = 800;
const DEFAULT_BUDGET = { maxAttempts: 2, maxWallClockSec: 900 };

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function kernelEnabled(): boolean {
  try {
    return env().COGNITIVE_KERNEL_ENABLED === true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max = MAX_STRING_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function validPositiveInt(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
}

function validScope(scope: CognitiveScope): boolean {
  try {
    scopeKey(scope);
    return true;
  } catch {
    return false;
  }
}

function sameScope(a: CognitiveScope, b: CognitiveScope): boolean {
  try {
    return scopeKey(a) === scopeKey(b);
  } catch {
    return false;
  }
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Keep event metadata structural and bounded. Hidden chain-of-thought and raw
 * transcript fields are intentionally dropped at this boundary; visible
 * message text remains owned by the normal context/message stores.
 */
function boundedValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundedValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 48)) {
      if (/^(?:thought|reasoning|chain_?of_?thought|raw_?(?:text|prompt)|system_?prompt)$/i.test(key)) continue;
      result[key.slice(0, 80)] = boundedValue(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

function boundedRecord(value: Record<string, unknown> | undefined, maxBytes: number): Record<string, unknown> {
  const candidate = boundedValue(value ?? {}) as Record<string, unknown>;
  if (jsonBytes(candidate) > maxBytes) {
    return { truncated: true, keys: Object.keys(candidate).slice(0, 16) };
  }
  return candidate;
}

function normalizePrediction(input?: KernelActionPrediction): KernelActionPrediction | undefined {
  if (!input) return undefined;
  const expectedEffect = boundedText(input.expectedEffect, 320);
  const watchFor = Array.isArray(input.watchFor)
    ? input.watchFor.map((item) => boundedText(item, 200)).filter((item): item is string => Boolean(item)).slice(0, 8)
    : [];
  return expectedEffect && watchFor.length ? { expectedEffect, watchFor } : undefined;
}

function normalizeBudget(input?: Partial<ActionEnvelope["budget"]>): ActionEnvelope["budget"] {
  const maxAttempts = validPositiveInt(input?.maxAttempts, 32) ? Number(input?.maxAttempts) : DEFAULT_BUDGET.maxAttempts;
  const maxWallClockSec = validPositiveInt(input?.maxWallClockSec, 7 * 86400)
    ? Number(input?.maxWallClockSec)
    : DEFAULT_BUDGET.maxWallClockSec;
  return { maxAttempts, maxWallClockSec };
}

/** Reconstruct the exact scope a persisted event was written under. */
export function scopeFromCognitiveEvent(event: CognitiveEvent): CognitiveScope {
  return eventScope(event);
}

function eventScope(event: CognitiveEvent): CognitiveScope {
  if (event.visibility === "global") return { visibility: "global" };
  if (event.visibility === "chat" && event.chatId !== null) return { visibility: "chat", chatId: event.chatId };
  if (event.visibility === "user" && event.userId !== null) {
    return {
      visibility: "user",
      userId: event.userId,
      ...(event.chatId === null ? {} : { chatId: event.chatId }),
    };
  }
  if (event.visibility === "task" && event.taskId) {
    return {
      visibility: "task",
      taskId: event.taskId,
      ...(event.chatId === null ? {} : { chatId: event.chatId }),
    };
  }
  return { visibility: "global" };
}

function eventMatchesScope(event: CognitiveEvent, scope: CognitiveScope): boolean {
  return sameScope(eventScope(event), scope);
}

function sortedEvents(events: CognitiveEvent[]): CognitiveEvent[] {
  return [...events].sort((a, b) => a.occurredAt - b.occurredAt || a.sequence - b.sequence || a.id.localeCompare(b.id));
}

function initialFrame(input: { scope: CognitiveScope; correlationId: string; asOf: number }): KernelFrame {
  return {
    schema: "kernel_frame.v1",
    scope: input.scope,
    scopeKey: scopeKey(input.scope),
    correlationId: input.correlationId,
    asOf: input.asOf,
    eventIds: [],
    triggerCount: 0,
    observationCount: 0,
    proposalCount: 0,
    outcomeCount: 0,
    envelopes: [],
    actions: [],
    outcomes: [],
    unknowns: [],
  };
}

function addUnknown(frame: KernelFrame, value: string): void {
  if (!frame.unknowns.includes(value) && frame.unknowns.length < 16) frame.unknowns.push(value);
}

/** Pure reducer used by both live frames and historical replay. */
export function reduceKernelEvent(frame: KernelFrame, event: CognitiveEvent): KernelFrame {
  if (!KERNEL_EVENT_TYPES.has(event.type) || !eventMatchesScope(event, frame.scope)) return frame;
  if (frame.eventIds.includes(event.id)) return frame;
  frame.eventIds.push(event.id);
  frame.asOf = Math.max(frame.asOf, event.occurredAt);
  const fact = event.fact;
  switch (event.type) {
    case "cognitive_trigger": {
      frame.triggerCount += 1;
      const kind = boundedText(fact["kind"], 80) ?? "unknown";
      frame.latestTrigger = { id: event.id, kind, occurredAt: event.occurredAt };
      break;
    }
    case "cognitive_frame_observed":
      frame.observationCount += 1;
      break;
    case "action_envelope_proposed": {
      const envelope = fact["envelope"] as Partial<ActionEnvelope> | undefined;
      if (!envelope || typeof envelope.id !== "string") {
        addUnknown(frame, "malformed_action_proposal");
        break;
      }
      frame.proposalCount += 1;
      if (frame.envelopes && !frame.envelopes.some((candidate) => candidate.id === envelope.id)) {
        // Events are already bounded at the append boundary. Keep the complete
        // envelope in the replay frame so a worker restart does not lose the
        // candidate payload or its idempotency lifecycle.
        frame.envelopes.push(envelope as ActionEnvelope);
      }
      if (!frame.actions.some((action) => action.id === envelope.id)) {
        frame.actions.push({
          id: envelope.id,
          kind: envelope.kind as KernelActionKind,
          lane: envelope.lane as KernelActionLane,
          status: envelope.status as KernelActionStatus,
          triggerEventId: String(envelope.triggerEventId ?? ""),
          createdAt: Number(envelope.createdAt ?? event.occurredAt),
        });
      }
      break;
    }
    case "action_envelope_transition": {
      const envelopeId = boundedText(fact["envelopeId"], 240);
      const status = boundedText(fact["status"], 40) as KernelActionStatus | undefined;
      const action = frame.actions.find((candidate) => candidate.id === envelopeId);
      const envelope = frame.envelopes?.find((candidate) => candidate.id === envelopeId);
      if (action && status) {
        action.status = status;
        if (envelope) envelope.status = status;
      } else {
        addUnknown(frame, "orphan_action_transition");
      }
      break;
    }
    case "action_envelope_outcome": {
      const envelopeId = boundedText(fact["envelopeId"], 240);
      const status = boundedText(fact["status"], 40) as KernelOutcomeStatus | undefined;
      if (!envelopeId || !status) {
        addUnknown(frame, "malformed_action_outcome");
        break;
      }
      frame.outcomeCount += 1;
      frame.outcomes.push({
        envelopeId,
        status,
        occurredAt: event.occurredAt,
        ...(typeof fact["predictionError"] === "number" ? { predictionError: Number(fact["predictionError"]) } : {}),
      });
      const action = frame.actions.find((candidate) => candidate.id === envelopeId);
      const envelope = frame.envelopes?.find((candidate) => candidate.id === envelopeId);
      if (action) {
        action.status = status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed";
        if (envelope) envelope.status = action.status;
      } else {
        addUnknown(frame, "orphan_action_outcome");
      }
      break;
    }
  }
  return frame;
}

/** Replay only kernel events in deterministic causal order. */
export function reduceKernelEvents(input: {
  scope: CognitiveScope;
  correlationId?: string;
  events: CognitiveEvent[];
  asOfEventId?: string;
}): KernelFrame {
  if (!validScope(input.scope)) throw new Error("invalid kernel scope");
  const relevant = sortedEvents(input.events.filter((event) => {
    if (!eventMatchesScope(event, input.scope)) return false;
    if (input.correlationId && event.correlationId !== input.correlationId) return false;
    return KERNEL_EVENT_TYPES.has(event.type);
  }));
  const asOf = relevant[relevant.length - 1]?.occurredAt ?? nowSec();
  const frame = initialFrame({
    scope: input.scope,
    correlationId: input.correlationId ?? relevant[0]?.correlationId ?? `kernel:${scopeKey(input.scope)}`,
    asOf,
  });
  for (const event of relevant) {
    reduceKernelEvent(frame, event);
    if (input.asOfEventId === event.id) break;
  }
  return frame;
}

function appendKernelEvent(
  input: Parameters<typeof appendCognitiveEvent>[0],
): { event: CognitiveEvent; inserted: boolean } | null {
  if (!kernelEnabled()) return null;
  return appendCognitiveEvent(input);
}

/** Create or reuse the kernel trigger that starts a cognitive turn. */
export function ingestKernelTrigger(input: KernelTriggerInput): KernelTriggerReceipt | null {
  if (!validScope(input.scope)) return null;
  const key = scopeKey(input.scope);
  const kind = boundedText(input.kind, 80);
  if (!kind) return null;
  const anchor = boundedText(input.anchorEventId, 240);
  const correlationId = boundedText(input.correlationId, 240) ?? `kernel:${key}:${anchor ?? kind}`;
  const dedupeKey = boundedText(input.dedupeKey, 240) ?? (anchor ? `kernel:trigger:${anchor}:${kind}` : undefined);
  const result = appendKernelEvent({
    type: "cognitive_trigger",
    source: input.source,
    scope: input.scope,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(anchor ? { causationId: anchor } : {}),
    correlationId,
    ...(dedupeKey ? { dedupeKey } : {}),
    fact: {
      schema: "cognitive_trigger.v1",
      kind,
      ...(anchor ? { anchorEventId: anchor } : {}),
      metadata: boundedRecord(input.metadata, MAX_METADATA_BYTES),
    },
  });
  if (!result) return null;
  return { event: result.event, inserted: result.inserted };
}

/** Open one materialized frame from the event stream and persist its summary. */
export function openKernelFrame(input: OpenKernelFrameInput): OpenKernelFrameResult | null {
  if (!validScope(input.scope)) return null;
  const trigger = input.triggerEventId ? getCognitiveEvent(input.triggerEventId) : null;
  if (input.triggerEventId && (!trigger || !eventMatchesScope(trigger, input.scope))) return null;
  const correlationId = input.correlationId ?? trigger?.correlationId;
  const events = listCognitiveEvents({
    ...(correlationId ? { correlationId } : {}),
    scope: input.scope,
    limit: Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 200))),
  });
  const frame = reduceKernelEvents({
    scope: input.scope,
    ...(correlationId ? { correlationId } : {}),
    events,
    ...(input.asOfEventId ? { asOfEventId: input.asOfEventId } : {}),
  });
  frame.triggerEventId = trigger?.id;
  const frameDedupe = `kernel:frame:${scopeKey(input.scope)}:${trigger?.id ?? correlationId ?? frame.asOf}`;
  const frameResult = appendKernelEvent({
    type: "cognitive_frame_observed",
    source: "host",
    scope: input.scope,
    ...(trigger?.id ? { causationId: trigger.id } : {}),
    correlationId: frame.correlationId,
    dedupeKey: frameDedupe,
    fact: {
      schema: "kernel_frame.v1",
      frame: {
        scopeKey: frame.scopeKey,
        triggerEventId: frame.triggerEventId ?? null,
        eventCount: frame.eventIds.length,
        triggerCount: frame.triggerCount,
        proposalCount: frame.proposalCount,
        outcomeCount: frame.outcomeCount,
        unknowns: frame.unknowns.slice(0, 16),
      },
    },
  });
  if (frameResult) frame.frameEventId = frameResult.event.id;
  return {
    frame,
    ...(frameResult ? { observedEventId: frameResult.event.id } : {}),
    inserted: frameResult?.inserted ?? false,
  };
}

function findEnvelope(scope: CognitiveScope, envelopeId: string): ActionEnvelope | null {
  const events = listCognitiveEvents({ scope, type: "action_envelope_proposed", order: "occurred_at_desc", limit: 500 });
  for (const event of events) {
    const envelope = event.fact["envelope"];
    if (!envelope || typeof envelope !== "object") continue;
    const candidate = envelope as ActionEnvelope;
    if (candidate.id === envelopeId && sameScope(candidate.scope, scope)) return candidate;
  }
  return null;
}

function findEnvelopeCorrelation(scope: CognitiveScope, envelopeId: string): string | undefined {
  const events = listCognitiveEvents({ scope, type: "action_envelope_proposed", order: "occurred_at_desc", limit: 500 });
  for (const event of events) {
    const envelope = event.fact["envelope"];
    if (!envelope || typeof envelope !== "object") continue;
    const candidate = envelope as ActionEnvelope;
    if (candidate.id === envelopeId && sameScope(candidate.scope, scope)) return event.correlationId;
  }
  return undefined;
}

function findEnvelopeByIdempotency(scope: CognitiveScope, idempotencyKey: string): ActionEnvelope | null {
  const events = listCognitiveEvents({ scope, type: "action_envelope_proposed", order: "occurred_at_desc", limit: 500 });
  for (const event of events) {
    const envelope = event.fact["envelope"];
    if (!envelope || typeof envelope !== "object") continue;
    if (event.fact["idempotencyKey"] !== idempotencyKey) continue;
    const candidate = envelope as ActionEnvelope;
    if (sameScope(candidate.scope, scope)) return candidate;
  }
  return null;
}

/** Persist a model/adapter candidate. This call never dispatches it. */
export function proposeKernelAction(input: ProposeKernelActionInput): KernelActionReceipt | null {
  if (!validScope(input.scope) || !validPositiveInt(input.idempotencyKey.length, 240)) return null;
  const trigger = getCognitiveEvent(input.triggerEventId);
  if (!trigger || !eventMatchesScope(trigger, input.scope)) return null;
  const frameEventId = boundedText(input.frameEventId, 240) ?? `frame:${trigger.id}`;
  const idempotencyKey = boundedText(input.idempotencyKey, 240);
  if (!idempotencyKey) return null;
  const createdAt = nowSec();
  const expiresAt = validPositiveInt(input.expiresAt, 4_102_444_800) ? Number(input.expiresAt) : undefined;
  const envelope: ActionEnvelope = {
    schema: "action_envelope.v1",
    id: randomUUID(),
    scope: input.scope,
    triggerEventId: trigger.id,
    frameEventId,
    lane: input.lane,
    kind: input.kind,
    payload: boundedRecord(input.payload, MAX_ACTION_PAYLOAD_BYTES),
    ...(normalizePrediction(input.prediction) ? { prediction: normalizePrediction(input.prediction) } : {}),
    budget: normalizeBudget(input.budget),
    ...(expiresAt ? { expiresAt } : {}),
    status: "candidate",
    createdAt,
  };
  const result = appendKernelEvent({
    type: "action_envelope_proposed",
    source: "model",
    scope: input.scope,
    causationId: trigger.id,
    correlationId: boundedText(input.correlationId, 240) ?? trigger.correlationId,
    dedupeKey: `kernel:action:${scopeKey(input.scope)}:${trigger.id}:${idempotencyKey}`,
    fact: { schema: "action_envelope.v1", idempotencyKey, envelope },
  });
  if (!result) return null;
  const existing = result.inserted ? envelope : findEnvelopeByIdempotency(input.scope, idempotencyKey);
  return { envelope: existing ?? envelope, eventId: result.event.id, inserted: result.inserted };
}

/** Record an accepted/dispatched transition without changing the envelope in-place. */
export function transitionKernelAction(input: {
  scope: CognitiveScope;
  envelopeId: string;
  status: Extract<KernelActionStatus, "accepted" | "dispatched" | "deferred" | "cancelled">;
  reason?: string;
  correlationId?: string;
  causationId?: string;
}): KernelOutcomeReceipt | null {
  if (!validScope(input.scope) || !findEnvelope(input.scope, input.envelopeId)) return null;
  const status = input.status;
  const proposalCorrelation = findEnvelopeCorrelation(input.scope, input.envelopeId);
  const result = appendKernelEvent({
    type: "action_envelope_transition",
    source: "host",
    scope: input.scope,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    correlationId: input.correlationId ?? proposalCorrelation ?? `kernel:action:${input.envelopeId}`,
    dedupeKey: `kernel:transition:${input.envelopeId}:${status}`,
    fact: {
      schema: "action_envelope_transition.v1",
      envelopeId: input.envelopeId,
      status,
      ...(input.reason ? { reason: boundedText(input.reason, 240) } : {}),
    },
  });
  return result ? { eventId: result.event.id, inserted: result.inserted } : null;
}

/** Close an action with a host receipt. Orphan outcomes are rejected. */
export function recordKernelActionOutcome(input: RecordKernelOutcomeInput): KernelOutcomeReceipt | null {
  if (!validScope(input.scope) || !findEnvelope(input.scope, input.envelopeId)) return null;
  const proposalCorrelation = findEnvelopeCorrelation(input.scope, input.envelopeId);
  const error = input.predictionError;
  const boundedError = typeof error === "number" && Number.isFinite(error) ? Math.min(1, Math.max(0, error)) : undefined;
  const occurredAt = validPositiveInt(input.occurredAt, 4_102_444_800) ? Number(input.occurredAt) : nowSec();
  const result = appendKernelEvent({
    type: "action_envelope_outcome",
    source: "host",
    scope: input.scope,
    ...(input.causationId ? { causationId: boundedText(input.causationId, 240) } : {}),
    occurredAt,
    correlationId: boundedText(input.correlationId, 240) ?? proposalCorrelation ?? `kernel:action:${input.envelopeId}`,
    dedupeKey: `kernel:outcome:${input.envelopeId}:${input.status}`,
    fact: {
      schema: "action_envelope_outcome.v1",
      envelopeId: input.envelopeId,
      status: input.status,
      ...(input.reason ? { reason: boundedText(input.reason, 240) } : {}),
      ...(boundedError === undefined ? {} : { predictionError: boundedError }),
      receipt: boundedRecord(input.receipt, MAX_METADATA_BYTES),
    },
  });
  return result ? { eventId: result.event.id, inserted: result.inserted } : null;
}

/** Build a frame from the persisted stream for dashboards and replay tools. */
export function readKernelFrame(input: {
  scope: CognitiveScope;
  correlationId?: string;
  asOfEventId?: string;
  limit?: number;
}): KernelFrame | null {
  if (!validScope(input.scope)) return null;
  const events = listCognitiveEvents({
    scope: input.scope,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    limit: Math.min(1000, Math.max(1, Math.trunc(input.limit ?? 500))),
  });
  return reduceKernelEvents({
    scope: input.scope,
    events,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.asOfEventId ? { asOfEventId: input.asOfEventId } : {}),
  });
}

export function isKernelEventType(type: string): type is CognitiveEventType {
  return KERNEL_EVENT_TYPES.has(type as CognitiveEventType);
}

/**
 * Kernel shadow rollout gate. The flag alone is not enough for a first
 * canary: an optional chatId list keeps the ledger bounded to internal chats.
 * An empty list keeps the historical "flag on = all chats" behavior.
 */
export function isKernelShadowChat(
  chatId: number,
  config: { enabled: boolean; chatIds: number[] },
): boolean {
  if (!config.enabled || !Number.isSafeInteger(chatId) || chatId === 0) return false;
  return config.chatIds.length === 0 || config.chatIds.includes(chatId);
}

/** Read the kernel rollout config from env; fails closed when env is unreadable. */
export function kernelShadowConfig(): { enabled: boolean; chatIds: number[] } {
  try {
    const current = env();
    return {
      enabled: current.COGNITIVE_KERNEL_ENABLED === true,
      chatIds: current.COGNITIVE_KERNEL_CHAT_IDS ?? [],
    };
  } catch {
    return { enabled: false, chatIds: [] };
  }
}
