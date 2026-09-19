// NyatOS Action Board.
//
// The board is a pure arbitration projection over candidate envelopes. It does
// not execute anything and does not encode a persona policy. Its only hard
// decisions are reality facts: expiry, exact scope, duplicate trigger conflict
// and whether the host has observed the capability required by an action.

import type { CapabilitySnapshot } from "./nyatos-contracts.js";
import type {
  ActionEnvelope,
  KernelActionKind,
  KernelActionLane,
} from "./cognitive-kernel.js";
import type { CognitiveScope } from "../shared/cognitive-scope.js";
import { scopeKey } from "../shared/cognitive-scope.js";

export type BoardCandidateState = "eligible" | "deferred" | "rejected";

export interface ActionBoardCandidate {
  envelope: ActionEnvelope;
  /** Optional model/adapter score; it is bounded and never grants authority. */
  priority?: number;
  /** Host affordances needed before the candidate can be dispatched. */
  requires?: BoardCapability[];
}

export type BoardCapability =
  | "send_text"
  | "send_media"
  | "react"
  | "poll"
  | "sticker"
  | "voice"
  | "delete_own";

export interface ActionBoardDecision {
  id: string;
  kind: KernelActionKind;
  lane: KernelActionLane;
  state: BoardCandidateState;
  score: number;
  reason: string;
  triggerEventId: string;
}

export interface ActionBoard {
  schema: "action_board.v1";
  scope: CognitiveScope;
  asOf: number;
  selected?: ActionBoardDecision;
  decisions: ActionBoardDecision[];
  deferredCount: number;
  rejectedCount: number;
}

export interface BuildActionBoardInput {
  scope: CognitiveScope;
  candidates: ActionBoardCandidate[];
  capability?: CapabilitySnapshot;
  nowSec?: number;
}

const MAX_CANDIDATES = 64;
const ACTION_BIAS: Readonly<Record<KernelActionKind, number>> = {
  speak: 6,
  share: 5,
  repair: 5,
  challenge: 4,
  work: 3,
  observe: 2,
  wait: 1,
  leave: 0,
};

function currentSec(value?: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Number(value)
    : Math.floor(Date.now() / 1000);
}

function boundedPriority(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(-100, value))
    : 0;
}

function capabilityValue(
  capability: CapabilitySnapshot | undefined,
  required: BoardCapability,
): boolean | null {
  if (!capability) return null;
  switch (required) {
    case "send_text": return capability.observed.canSendText;
    case "send_media": return capability.observed.canSendMedia;
    case "react": return capability.observed.canReact;
    case "poll": return capability.observed.canPoll;
    case "sticker": return capability.observed.canSendSticker;
    case "voice": return capability.observed.canSendVoice;
    case "delete_own": return capability.observed.canDeleteOwn;
  }
}

function defaultRequirements(kind: KernelActionKind): BoardCapability[] {
  switch (kind) {
    case "speak":
    case "share":
    case "repair":
    case "challenge":
      return ["send_text"];
    default:
      return [];
  }
}

function decisionFor(
  candidate: ActionBoardCandidate,
  scope: CognitiveScope,
  capability: CapabilitySnapshot | undefined,
  asOf: number,
): ActionBoardDecision {
  const envelope = candidate.envelope;
  const base = {
    id: envelope.id,
    kind: envelope.kind,
    lane: envelope.lane,
    score: ACTION_BIAS[envelope.kind] + boundedPriority(candidate.priority),
    triggerEventId: envelope.triggerEventId,
  };
  let state: BoardCandidateState = "eligible";
  let reason = "eligible";
  if (!sameScope(envelope.scope, scope)) {
    state = "rejected";
    reason = "scope_mismatch";
  } else if (envelope.expiresAt !== undefined && envelope.expiresAt <= asOf) {
    state = "rejected";
    reason = "expired";
  } else if (envelope.status !== "candidate" && envelope.status !== "deferred" && envelope.status !== "accepted") {
    state = "rejected";
    reason = `status_${envelope.status}`;
  } else {
    const requirements = candidate.requires ?? defaultRequirements(envelope.kind);
    const unknown = requirements.some((item) => capabilityValue(capability, item) === null);
    const unavailable = requirements.some((item) => capabilityValue(capability, item) === false);
    if (unavailable) {
      state = "rejected";
      reason = "host_capability_unavailable";
    } else if (unknown) {
      state = "deferred";
      reason = "host_capability_unknown";
    }
  }
  return { ...base, state, reason };
}

function sameScope(a: CognitiveScope, b: CognitiveScope): boolean {
  try { return scopeKey(a) === scopeKey(b); } catch { return false; }
}

/**
 * Build a bounded board and choose at most one candidate per trigger. The
 * result is safe to replay because no clock, network or random value is read
 * after `asOf` is resolved.
 */
export function buildActionBoard(input: BuildActionBoardInput): ActionBoard {
  const asOf = currentSec(input.nowSec);
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
  const decisions = candidates.map((candidate) => decisionFor(candidate, input.scope, input.capability, asOf));
  const eligible = decisions
    .filter((decision) => decision.state === "eligible")
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const winner = eligible[0];
  if (winner) {
    for (const decision of decisions) {
      if (decision.id !== winner.id && decision.state === "eligible" && decision.triggerEventId === winner.triggerEventId) {
        decision.state = "rejected";
        decision.reason = "trigger_conflict";
      }
    }
  }
  return {
    schema: "action_board.v1",
    scope: input.scope,
    asOf,
    ...(winner ? { selected: winner } : {}),
    decisions,
    deferredCount: decisions.filter((decision) => decision.state === "deferred").length,
    rejectedCount: decisions.filter((decision) => decision.state === "rejected").length,
  };
}

/** Return the candidate selected by the board, if the host can execute one. */
export function selectedAction(board: ActionBoard): string | undefined {
  return board.selected?.state === "eligible" ? board.selected.id : undefined;
}
