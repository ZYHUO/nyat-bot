// Evidence-gated action circuits.
//
// A circuit is a compact, replayable description of an action sequence. Model
// output may propose one, but only host receipts plus held-out replay evidence
// may verify and publish it. Published circuits remain scoped and expirable.

import { z } from 'zod';
import { appendCognitiveEvent, listCognitiveEvents } from './cognitive-events.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

const circuitStepSchema = z.object({
  action: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(240),
  preconditions: z.array(z.string().trim().min(1).max(160)).max(8),
}).strict();

export const actionCircuitSchema = z.object({
  schema: z.literal('action_circuit.v1'),
  name: z.string().trim().min(1).max(120),
  scope: z.object({
    visibility: z.literal('chat'),
    chatId: z.number().int().refine((value) => value !== 0),
  }).strict(),
  trigger: z.string().trim().min(1).max(240),
  preconditions: z.array(z.string().trim().min(1).max(160)).max(8),
  steps: z.array(circuitStepSchema).min(1).max(8),
  acceptanceChecks: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  sourceEventIds: z.array(z.string().trim().min(1).max(240)).max(32),
  expiresAt: z.number().int().positive().optional(),
}).strict();
export type ActionCircuit = z.infer<typeof actionCircuitSchema>;

export type CircuitEvaluationStatus = 'verified' | 'unverified' | 'failed';

export const actionCircuitEvaluationSchema = z.object({
  schema: z.literal('action_circuit_evaluation.v1'),
  circuitId: z.string().trim().min(1).max(240),
  scope: z.object({
    visibility: z.literal('chat'),
    chatId: z.number().int().refine((value) => value !== 0),
  }).strict(),
  status: z.enum(['verified', 'unverified', 'failed']),
  evaluatedAt: z.number().int().positive(),
  hostReceiptIds: z.array(z.string().trim().min(1).max(240)).max(32),
  replaySamples: z.number().int().min(0).max(1000),
  replaySuccesses: z.number().int().min(0).max(1000),
  falseSuccesses: z.number().int().min(0).max(1000),
  failureModes: z.array(z.string().trim().min(1).max(200)).max(8),
  summary: z.string().trim().max(400).optional(),
}).strict();
export type ActionCircuitEvaluation = z.infer<typeof actionCircuitEvaluationSchema>;

export interface PublishedActionCircuit {
  circuitId: string;
  eventId: string;
  circuit: ActionCircuit;
  evaluation: ActionCircuitEvaluation;
  publishedAt: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function validScope(scope: CognitiveScope): scope is CognitiveScope & { visibility: 'chat'; chatId: number } {
  return scope.visibility === 'chat' && Number.isSafeInteger(scope.chatId) && scope.chatId !== 0;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function uniqueIds(values: readonly string[] | undefined, max = 32): string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().slice(0, 240))
    .filter(Boolean))].slice(0, max);
}

function parseCircuit(event: ReturnType<typeof listCognitiveEvents>[number]): ActionCircuit | null {
  const value = event.fact['value'];
  const parsed = actionCircuitSchema.safeParse(value);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  return parsed.data;
}

function parseEvaluation(event: ReturnType<typeof listCognitiveEvents>[number]): ActionCircuitEvaluation | null {
  const value = event.fact['value'];
  const parsed = actionCircuitEvaluationSchema.safeParse(value);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  return parsed.data;
}

function boundedInt(value: unknown, fallback = 0, max = 1000): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.trunc(n))) : fallback;
}

function circuitEvent(circuitId: string, scope?: CognitiveScope) {
  return listCognitiveEvents({
    ...(scope ? { scope } : {}),
    type: 'action_circuit_proposed',
    order: 'occurred_at_desc',
    limit: 500,
  }).find((event) => event.id === circuitId) ?? null;
}

/** Store a model proposal only; it has no execution effect. */
export function recordActionCircuitProposal(input: ActionCircuit, options: { correlationId?: string; causationId?: string } = {}): { inserted: boolean; eventId: string } | null {
  const parsed = actionCircuitSchema.safeParse(input);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  const sourceEventIds = uniqueIds(parsed.data.sourceEventIds);
  const value: ActionCircuit = { ...parsed.data, sourceEventIds };
  const result = appendCognitiveEvent({
    type: 'action_circuit_proposed',
    source: 'model',
    scope: value.scope,
    ...(options.correlationId ? { correlationId: boundedText(options.correlationId, 240) } : {}),
    ...(options.causationId ? { causationId: boundedText(options.causationId, 240) } : {}),
    dedupeKey: `action-circuit:${scopeKey(value.scope)}:${value.name}:${sourceEventIds.join(',')}`.slice(0, 240),
    fact: { schema: value.schema, value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/**
 * Summarize a deterministic replay. This helper is intentionally pure so a
 * held-out evaluator can feed real receipts without exposing prompt content.
 */
export function summarizeCircuitReplay(samples: readonly { succeeded: boolean; falseSuccess?: boolean }[]): {
  replaySamples: number;
  replaySuccesses: number;
  falseSuccesses: number;
  successRate: number;
} {
  const replaySamples = Math.min(1000, samples.length);
  const replaySuccesses = samples.slice(0, replaySamples).filter((sample) => sample.succeeded).length;
  const falseSuccesses = samples.slice(0, replaySamples).filter((sample) => sample.falseSuccess === true).length;
  return {
    replaySamples,
    replaySuccesses,
    falseSuccesses,
    successRate: replaySamples > 0 ? Number((replaySuccesses / replaySamples).toFixed(4)) : 0,
  };
}

function safeStatus(input: {
  requested: CircuitEvaluationStatus;
  hostReceiptIds: string[];
  replaySamples: number;
  replaySuccesses: number;
  falseSuccesses: number;
}): CircuitEvaluationStatus {
  if (input.requested === 'failed') return 'failed';
  if (input.hostReceiptIds.length < 1 || input.replaySamples < 3 || input.replaySuccesses !== input.replaySamples || input.falseSuccesses > 0) return 'unverified';
  return 'verified';
}

/** Host-owned evaluation. A model cannot mark its own circuit verified. */
export function recordActionCircuitEvaluation(input: {
  circuitId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  requestedStatus: CircuitEvaluationStatus;
  evaluatedAt?: number;
  hostReceiptIds: string[];
  replaySamples: number;
  replaySuccesses: number;
  falseSuccesses: number;
  failureModes?: string[];
  summary?: string;
}): { inserted: boolean; eventId: string; status: CircuitEvaluationStatus } | null {
  if (!validScope(input.scope)) return null;
  const proposal = circuitEvent(input.circuitId, input.scope);
  const circuit = proposal ? parseCircuit(proposal) : null;
  if (!proposal || !circuit || scopeKey(circuit.scope) !== scopeKey(input.scope)) return null;
  const hostReceiptIds = uniqueIds(input.hostReceiptIds);
  const replaySamples = boundedInt(input.replaySamples);
  const replaySuccesses = Math.min(replaySamples, boundedInt(input.replaySuccesses));
  const falseSuccesses = boundedInt(input.falseSuccesses);
  const status = safeStatus({ requested: input.requestedStatus, hostReceiptIds, replaySamples, replaySuccesses, falseSuccesses });
  const evaluatedAt = Number.isSafeInteger(input.evaluatedAt) && (input.evaluatedAt ?? 0) > 0 ? input.evaluatedAt! : nowSec();
  const value: ActionCircuitEvaluation = {
    schema: 'action_circuit_evaluation.v1',
    circuitId: proposal.id,
    scope: input.scope,
    status,
    evaluatedAt,
    hostReceiptIds,
    replaySamples,
    replaySuccesses,
    falseSuccesses,
    failureModes: uniqueIds(input.failureModes, 8),
    ...(boundedText(input.summary, 400) ? { summary: boundedText(input.summary, 400) } : {}),
  };
  const result = appendCognitiveEvent({
    type: 'action_circuit_evaluated',
    source: 'host',
    scope: input.scope,
    occurredAt: evaluatedAt,
    causationId: proposal.id,
    correlationId: `circuit:${proposal.id}`,
    dedupeKey: `action-circuit-eval:${proposal.id}:${evaluatedAt}`,
    fact: { schema: value.schema, value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id, status } : null;
}

/** Publish only the latest host-verified evaluation. */
export function publishActionCircuit(input: { circuitId: string; scope: CognitiveScope & { visibility: 'chat'; chatId: number }; publishedAt?: number }): { inserted: boolean; eventId: string } | null {
  if (!validScope(input.scope)) return null;
  const proposal = circuitEvent(input.circuitId, input.scope);
  const circuit = proposal ? parseCircuit(proposal) : null;
  if (!proposal || !circuit || scopeKey(circuit.scope) !== scopeKey(input.scope)) return null;
  const evaluations = listCognitiveEvents({ scope: input.scope, type: 'action_circuit_evaluated', order: 'occurred_at_desc', limit: 500 })
    .map((event) => ({ event, value: parseEvaluation(event) }))
    .filter((item): item is { event: ReturnType<typeof listCognitiveEvents>[number]; value: ActionCircuitEvaluation } => item.value !== null && item.value.circuitId === proposal.id);
  const latest = evaluations[0];
  if (!latest || latest.value.status !== 'verified') return null;
  const publishedAt = Number.isSafeInteger(input.publishedAt) && (input.publishedAt ?? 0) > 0 ? input.publishedAt! : nowSec();
  if (circuit.expiresAt !== undefined && circuit.expiresAt <= publishedAt) return null;
  const result = appendCognitiveEvent({
    type: 'action_circuit_published',
    source: 'host',
    scope: input.scope,
    occurredAt: publishedAt,
    causationId: latest.event.id,
    correlationId: `circuit:${proposal.id}`,
    dedupeKey: `action-circuit-published:${proposal.id}`,
    fact: { schema: 'action_circuit_published.v1', value: { circuitId: proposal.id, scope: input.scope, publishedAt } },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/** Return only host-published, non-expired circuits for an exact chat scope. */
export function listPublishedActionCircuits(scope: CognitiveScope & { visibility: 'chat'; chatId: number }, limit = 20, now = nowSec()): PublishedActionCircuit[] {
  if (!validScope(scope)) return [];
  const published = listCognitiveEvents({ scope, type: 'action_circuit_published', order: 'occurred_at_desc', limit: 500 });
  const out: PublishedActionCircuit[] = [];
  for (const event of published) {
    const raw = event.fact['value'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const circuitId = boundedText((raw as Record<string, unknown>)['circuitId'], 240);
    const proposal = circuitEvent(circuitId, scope);
    const circuit = proposal ? parseCircuit(proposal) : null;
    if (!proposal || !circuit || (circuit.expiresAt !== undefined && circuit.expiresAt <= now)) continue;
    const evaluation = listCognitiveEvents({ scope, type: 'action_circuit_evaluated', order: 'occurred_at_desc', limit: 500 })
      .map(parseEvaluation)
      .find((value): value is ActionCircuitEvaluation => value !== null && value.circuitId === circuitId);
    if (!evaluation || evaluation.status !== 'verified') continue;
    out.push({ circuitId, eventId: event.id, circuit, evaluation, publishedAt: event.occurredAt });
    if (out.length >= Math.min(100, Math.max(1, Math.trunc(limit)))) break;
  }
  return out;
}
