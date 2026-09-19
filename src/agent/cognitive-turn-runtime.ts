// NyatOS turn runtime.
//
// This is the lifecycle owner between host observations and a host adapter. It
// deliberately does not call an LLM, Telegram, Redis, or a tool. Existing
// Heart, Meta, Reply, and CodeAct paths can therefore enter as lenses/adapters
// while replay and tests use the same state machine without side effects.

import {
  ingestKernelTrigger,
  openKernelFrame,
  proposeKernelAction,
  recordKernelActionOutcome,
  transitionKernelAction,
  type ActionEnvelope,
  type KernelActionKind,
  type KernelActionLane,
  type KernelActionPrediction,
  type KernelActionStatus,
  type KernelOutcomeStatus,
  type KernelTriggerKind,
  type KernelTriggerReceipt,
  type OpenKernelFrameResult,
  type ProposeKernelActionInput,
  type KernelActionReceipt,
  type KernelOutcomeReceipt,
  type RecordKernelOutcomeInput,
} from './cognitive-kernel.js';
import {
  buildActionBoard,
  selectedAction,
  type ActionBoard,
  type ActionBoardCandidate,
} from './action-board.js';
import type { CapabilitySnapshot } from './nyatos-contracts.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';
import { scopeKey } from '../shared/cognitive-scope.js';

export interface KernelRuntimePort {
  ingest: (input: Parameters<typeof ingestKernelTrigger>[0]) => KernelTriggerReceipt | null;
  openFrame: (input: Parameters<typeof openKernelFrame>[0]) => OpenKernelFrameResult | null;
  propose: (input: ProposeKernelActionInput) => KernelActionReceipt | null;
  transition: (input: Parameters<typeof transitionKernelAction>[0]) => KernelOutcomeReceipt | null;
  settle: (input: RecordKernelOutcomeInput) => KernelOutcomeReceipt | null;
}

const defaultPort: KernelRuntimePort = {
  ingest: ingestKernelTrigger,
  openFrame: openKernelFrame,
  propose: proposeKernelAction,
  transition: transitionKernelAction,
  settle: recordKernelActionOutcome,
};

export type CognitiveTurnPhase =
  | 'opened'
  | 'proposed'
  | 'arbitrated'
  | 'executing'
  | 'settled'
  | 'aborted';

export interface CognitiveTurn {
  schema: 'cognitive_turn.v1';
  id: string;
  scope: CognitiveScope;
  triggerEventId: string;
  frameEventId?: string;
  correlationId: string;
  phase: CognitiveTurnPhase;
  candidates: ActionEnvelope[];
  candidateMeta: Map<string, Pick<ActionBoardCandidate, 'priority' | 'requires'>>;
  selectedEnvelopeId?: string;
  transitionedEnvelopeIds: string[];
  settledEnvelopeIds: string[];
  /** True when the turn was rebuilt from the durable kernel frame. */
  rehydrated?: boolean;
}

export interface OpenCognitiveTurnInput {
  scope: CognitiveScope;
  kind: KernelTriggerKind;
  source: Parameters<typeof ingestKernelTrigger>[0]['source'];
  anchorEventId?: string;
  correlationId: string;
  dedupeKey: string;
  occurredAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ProposeCognitiveTurnActionInput {
  lane: KernelActionLane;
  kind: KernelActionKind;
  payload?: Record<string, unknown>;
  prediction?: KernelActionPrediction;
  budget?: Partial<ActionEnvelope['budget']>;
  expiresAt?: number;
  idempotencyKey: string;
  correlationId?: string;
  priority?: number;
  requires?: ActionBoardCandidate['requires'];
}

export interface SettleCognitiveTurnInput {
  envelopeId?: string;
  status: KernelOutcomeStatus;
  receipt?: Record<string, unknown>;
  occurredAt?: number;
  predictionError?: number;
  reason?: string;
  causationId?: string;
}

export interface CognitiveTurnAbortInput {
  reason: string;
  envelopeId?: string;
  causationId?: string;
}

function sameScope(left: CognitiveScope, right: CognitiveScope): boolean {
  try {
    return scopeKey(left) === scopeKey(right);
  } catch {
    return false;
  }
}

function boundedText(value: string, max = 240): string {
  return value.trim().slice(0, max);
}

function canPropose(phase: CognitiveTurnPhase): boolean {
  return phase === 'opened' || phase === 'proposed';
}

/**
 * Own one trigger -> frame -> candidate -> arbitration -> receipt lifecycle.
 * The runtime is intentionally small: authority stays in the injected port,
 * while all callers share the same phase transitions and correlation.
 */
export class CognitiveTurnRuntime {
  private readonly port: KernelRuntimePort;

  public constructor(port: KernelRuntimePort = defaultPort) {
    this.port = port;
  }

  public open(input: OpenCognitiveTurnInput): CognitiveTurn | null {
    const trigger = this.port.ingest({
      scope: input.scope,
      kind: input.kind,
      source: input.source,
      ...(input.anchorEventId ? { anchorEventId: input.anchorEventId } : {}),
      correlationId: boundedText(input.correlationId),
      dedupeKey: boundedText(input.dedupeKey),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    if (!trigger) return null;
    const frame = this.port.openFrame({
      scope: input.scope,
      triggerEventId: trigger.event.id,
      correlationId: trigger.event.correlationId,
    });
    if (!frame) return null;
    const restoredCandidates = (frame.frame.envelopes ?? [])
      .filter((envelope) => envelope.triggerEventId === trigger.event.id)
      .slice(0, 64);
    const selected = restoredCandidates.find((envelope) => envelope.status === 'accepted' || envelope.status === 'dispatched');
    const allTerminal = restoredCandidates.length > 0 && restoredCandidates.every((envelope) =>
      envelope.status === 'completed' || envelope.status === 'failed' || envelope.status === 'cancelled');
    const phase: CognitiveTurnPhase = allTerminal
      ? 'settled'
      : restoredCandidates.some((envelope) => envelope.status === 'dispatched')
        ? 'executing'
        : restoredCandidates.length > 0
          ? 'proposed'
          : 'opened';
    return {
      schema: 'cognitive_turn.v1',
      id: trigger.event.correlationId,
      scope: input.scope,
      triggerEventId: trigger.event.id,
      ...(frame.observedEventId ? { frameEventId: frame.observedEventId } : {}),
      correlationId: trigger.event.correlationId,
      phase,
      candidates: restoredCandidates,
      candidateMeta: new Map(),
      ...(selected ? { selectedEnvelopeId: selected.id } : {}),
      transitionedEnvelopeIds: [],
      settledEnvelopeIds: [],
      ...(restoredCandidates.length > 0 ? { rehydrated: true } : {}),
    };
  }

  public propose(turn: CognitiveTurn, input: ProposeCognitiveTurnActionInput): ActionEnvelope | null {
    if (!canPropose(turn.phase)) return null;
    const result = this.port.propose({
      scope: turn.scope,
      triggerEventId: turn.triggerEventId,
      ...(turn.frameEventId ? { frameEventId: turn.frameEventId } : {}),
      lane: input.lane,
      kind: input.kind,
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.prediction ? { prediction: input.prediction } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      idempotencyKey: boundedText(input.idempotencyKey),
      correlationId: input.correlationId ?? turn.correlationId,
    });
    if (!result || !sameScope(result.envelope.scope, turn.scope)) return null;
    const existing = turn.candidates.find((candidate) => candidate.id === result.envelope.id);
    if (!existing) turn.candidates.push(result.envelope);
    turn.candidateMeta.set(result.envelope.id, {
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.requires === undefined ? {} : { requires: input.requires }),
    });
    turn.phase = 'proposed';
    return existing ?? result.envelope;
  }

  public arbitrate(
    turn: CognitiveTurn,
    input: { capability?: CapabilitySnapshot; nowSec?: number } = {},
  ): ActionBoard | null {
    if (turn.phase === 'settled' || turn.phase === 'aborted') return null;
    const candidates: ActionBoardCandidate[] = turn.candidates.map((envelope) => ({
      envelope,
      ...(turn.candidateMeta.get(envelope.id) ?? {}),
    }));
    const board = buildActionBoard({
      scope: turn.scope,
      candidates,
      ...(input.capability ? { capability: input.capability } : {}),
      ...(input.nowSec === undefined ? {} : { nowSec: input.nowSec }),
    });
    const selectedId = selectedAction(board);
    if (selectedId) {
      this.transition(turn, selectedId, 'accepted', 'action_board_selected');
      turn.selectedEnvelopeId = selectedId;
    }
    for (const decision of board.decisions) {
      if (decision.id === selectedId) continue;
      if (decision.state === 'deferred') {
        // Deferral is a lifecycle fact, not an in-memory board result: persist
        // it so a restart or a later frame can see the action was withheld for
        // a missing host capability instead of silently disappearing.
        this.transition(turn, decision.id, 'deferred', `action_board_${decision.reason}`);
        continue;
      }
      this.transition(turn, decision.id, 'cancelled', `action_board_${decision.reason}`);
    }
    turn.phase = 'arbitrated';
    return board;
  }

  public transition(
    turn: CognitiveTurn,
    envelopeId: string,
    status: Extract<KernelActionStatus, 'accepted' | 'dispatched' | 'deferred' | 'cancelled'>,
    reason?: string,
  ): KernelOutcomeReceipt | null {
    if (!turn.candidates.some((candidate) => candidate.id === envelopeId)) return null;
    const result = this.port.transition({
      scope: turn.scope,
      envelopeId,
      status,
      ...(reason ? { reason: boundedText(reason) } : {}),
      correlationId: turn.correlationId,
      causationId: turn.triggerEventId,
    });
    if (result?.inserted && !turn.transitionedEnvelopeIds.includes(envelopeId)) {
      turn.transitionedEnvelopeIds.push(envelopeId);
    }
    if (status === 'dispatched') turn.phase = 'executing';
    return result;
  }

  public settle(turn: CognitiveTurn, input: SettleCognitiveTurnInput): KernelOutcomeReceipt | null {
    const envelopeId = input.envelopeId ?? turn.selectedEnvelopeId;
    if (!envelopeId || !turn.candidates.some((candidate) => candidate.id === envelopeId)) return null;
    const result = this.port.settle({
      scope: turn.scope,
      envelopeId,
      status: input.status,
      ...(input.receipt ? { receipt: input.receipt } : {}),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      ...(input.predictionError === undefined ? {} : { predictionError: input.predictionError }),
      ...(input.reason ? { reason: boundedText(input.reason) } : {}),
      correlationId: turn.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : { causationId: turn.triggerEventId }),
    });
    if (result?.inserted) {
      turn.settledEnvelopeIds.push(envelopeId);
      turn.phase = input.status === 'interrupted' ? 'aborted' : 'settled';
    }
    return result;
  }

  public abort(turn: CognitiveTurn, input: CognitiveTurnAbortInput): KernelOutcomeReceipt | null {
    const result = this.settle(turn, {
      ...(input.envelopeId ? { envelopeId: input.envelopeId } : {}),
      status: 'interrupted',
      reason: input.reason,
      ...(input.causationId ? { causationId: input.causationId } : {}),
    });
    if (result?.inserted) turn.phase = 'aborted';
    return result;
  }
}

/** Production singleton; tests should inject a fake port into the class. */
export const cognitiveTurnRuntime = new CognitiveTurnRuntime();
