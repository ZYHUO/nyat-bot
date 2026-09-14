// Host-owned action registration semantics.
//
// An Agency action is not a free-floating model proposal: it must be anchored
// to an observed event, point back to the trigger that caused it, and name the
// obligation it is meant to advance. These labels are audit/replay facts only;
// they do not make an action executable or verified.

import {
  createAgencyEnvelope,
  type AgencyEnvelopeValidation,
  type CreateAgencyEnvelopeInput,
} from "./agency-runtime.js";
import type { AgencyAction } from "./agency.js";
import { scopeKey, type CognitiveScope } from "../shared/cognitive-scope.js";

export type AgencyActionSource =
  | "reply"
  | "heart"
  | "meta"
  | "timing"
  | "codeact"
  | "core"
  | "scheduler"
  | "legacy";

export interface AgencyActionSemantics {
  anchorEventId: string;
  triggerEventId: string;
  obligationId: string;
  source: AgencyActionSource;
}

export interface AnchoredAgencyEnvelopeInput extends Omit<
  CreateAgencyEnvelopeInput,
  "action" | "scope"
> {
  action: AgencyAction;
  scope: CognitiveScope;
  source: AgencyActionSource;
  anchorEventId?: string;
  triggerEventId?: string;
  obligationId?: string;
}

function bounded(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

function actionObligation(action: AgencyAction): string | undefined {
  if (action.type === "act" && action.taskId?.trim())
    return `task:${action.taskId.trim()}`;
  if (action.type === "correct") return `debt:${action.debtId}`;
  return undefined;
}

/** Derive stable semantics without accepting model-provided provenance. */
export function deriveAgencyActionSemantics(input: {
  action: AgencyAction;
  scope: CognitiveScope;
  source: AgencyActionSource;
  anchorEventId?: string;
  triggerEventId?: string;
  obligationId?: string;
  idempotencyKey: string;
}): AgencyActionSemantics {
  const anchor =
    bounded(input.anchorEventId, 240) ??
    bounded(input.triggerEventId, 240) ??
    bounded(input.obligationId, 240) ??
    `scope:${scopeKey(input.scope)}`;
  const trigger = bounded(input.triggerEventId, 240) ?? anchor;
  const obligation =
    bounded(input.obligationId, 240) ??
    actionObligation(input.action) ??
    `action:${input.idempotencyKey.slice(0, 180)}`;
  return {
    anchorEventId: anchor,
    triggerEventId: trigger,
    obligationId: obligation,
    source: input.source,
  };
}

/** Build an envelope with one canonical anchor/trigger/obligation contract. */
export function createAnchoredAgencyEnvelope(
  input: AnchoredAgencyEnvelopeInput,
): AgencyEnvelopeValidation {
  const semantics = deriveAgencyActionSemantics(input);
  const result = createAgencyEnvelope({
    action: input.action,
    scope: input.scope,
    idempotencyKey: input.idempotencyKey,
    ...(input.correlationId !== undefined
      ? { correlationId: input.correlationId }
      : {}),
    ...(input.causationId !== undefined
      ? { causationId: input.causationId }
      : {}),
    ...(input.expectedOutcome !== undefined
      ? { expectedOutcome: input.expectedOutcome }
      : {}),
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    semantics,
  });
  return result;
}
