// Active perception and self-authored value proposals.
//
// Models may ask the host to look at something or suggest an interest. The
// proposal is durable and scoped, but it is not an observation, goal, policy,
// or permission. Only a host-owned receipt can settle a sensor proposal, and
// only a host-owned evaluation can retain/adopt a value proposal.

import {
  appendCognitiveEvent,
  listCognitiveEvents,
  type CognitiveEvent,
} from './cognitive-events.js';
import {
  parseSensorProposal,
  parseValueProposal,
  sensorProposalSchema,
  valueProposalSchema,
  type SensorProposal,
  type ValueProposal,
} from './nyatos-contracts.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

export type SensorObservationStatus = 'observed' | 'verified' | 'rejected' | 'expired';
export type ValueEvaluationStatus = 'retained' | 'unverified' | 'rejected' | 'expired';

export interface SensorObservation {
  schema: 'sensor_observation.v1';
  proposalId: string;
  scope: CognitiveScope;
  status: SensorObservationStatus;
  observedAt: number;
  evidenceEventIds: string[];
  checksPassed: number;
  checksTotal: number;
  summary?: string;
}

export interface ValueEvaluation {
  schema: 'value_evaluation.v1';
  proposalId: string;
  scope: CognitiveScope;
  status: ValueEvaluationStatus;
  evaluatedAt: number;
  evidenceEventIds: string[];
  checksPassed: number;
  checksTotal: number;
  predictionError?: number;
  summary?: string;
}

export interface SensorProposalRecord {
  proposalId: string;
  eventId: string;
  occurredAt: number;
  proposal: SensorProposal;
  latestObservation?: SensorObservation;
}

export interface ValueProposalRecord {
  proposalId: string;
  eventId: string;
  occurredAt: number;
  proposal: ValueProposal;
  latestEvaluation?: ValueEvaluation;
  adopted: boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function validScope(scope: CognitiveScope): boolean {
  try {
    scopeKey(scope);
    return true;
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function boundedPositive(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(max, n) : fallback;
}

function uniqueIds(values: readonly string[] | undefined, max = 32): string[] {
  return [...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().slice(0, 240))
    .filter(Boolean))].slice(0, max);
}

function valueFromEvent<T>(event: CognitiveEvent, parser: (value: unknown) => T | null): T | null {
  return parser(event.fact['value']);
}

function proposalEvent(
  type: 'sensor_proposed' | 'value_proposed',
  proposalId: string,
  scope?: CognitiveScope,
): CognitiveEvent | null {
  return listCognitiveEvents({
    ...(scope ? { scope } : {}),
    type,
    order: 'occurred_at_desc',
    limit: 500,
  }).find((event) => event.id === proposalId) ?? null;
}

function appendSettlement(input: {
  type: 'sensor_observed' | 'value_evaluated';
  source: 'host' | 'scheduler';
  scope: CognitiveScope;
  proposalId: string;
  value: SensorObservation | ValueEvaluation;
  occurredAt: number;
  dedupeKey: string;
  causationId: string;
}): { inserted: boolean; eventId: string } | null {
  const result = appendCognitiveEvent({
    type: input.type,
    source: input.source,
    scope: input.scope,
    occurredAt: input.occurredAt,
    correlationId: `${input.type}:${input.proposalId}`,
    causationId: input.causationId,
    dedupeKey: input.dedupeKey.slice(0, 240),
    fact: { schema: input.value.schema, value: input.value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

function parseSensorObservation(event: CognitiveEvent): SensorObservation | null {
  const value = event.fact['value'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const status = candidate['status'];
  const scope = candidate['scope'];
  const proposalId = boundedText(candidate['proposalId'], 240);
  const observedAt = candidate['observedAt'];
  if (!proposalId || !['observed', 'verified', 'rejected', 'expired'].includes(String(status))
    || !scope || typeof scope !== 'object' || Array.isArray(scope)
    || !Number.isSafeInteger(observedAt) || Number(observedAt) <= 0) return null;
  if (!validScope(scope as CognitiveScope)) return null;
  return {
    schema: 'sensor_observation.v1',
    proposalId,
    scope: scope as CognitiveScope,
    status: status as SensorObservationStatus,
    observedAt: Number(observedAt),
    evidenceEventIds: uniqueIds(Array.isArray(candidate['evidenceEventIds']) ? candidate['evidenceEventIds'] as string[] : []),
    checksPassed: boundedPositive(candidate['checksPassed'], 0, 32),
    checksTotal: boundedPositive(candidate['checksTotal'], 0, 32),
    ...(boundedText(candidate['summary'], 480) ? { summary: boundedText(candidate['summary'], 480) } : {}),
  };
}

function parseValueEvaluation(event: CognitiveEvent): ValueEvaluation | null {
  const value = event.fact['value'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const status = candidate['status'];
  const scope = candidate['scope'];
  const proposalId = boundedText(candidate['proposalId'], 240);
  const evaluatedAt = candidate['evaluatedAt'];
  if (!proposalId || !['retained', 'unverified', 'rejected', 'expired'].includes(String(status))
    || !scope || typeof scope !== 'object' || Array.isArray(scope)
    || !Number.isSafeInteger(evaluatedAt) || Number(evaluatedAt) <= 0) return null;
  if (!validScope(scope as CognitiveScope)) return null;
  const predictionError = typeof candidate['predictionError'] === 'number'
    && Number.isFinite(candidate['predictionError'])
    ? Math.min(1, Math.max(0, candidate['predictionError']))
    : undefined;
  return {
    schema: 'value_evaluation.v1',
    proposalId,
    scope: scope as CognitiveScope,
    status: status as ValueEvaluationStatus,
    evaluatedAt: Number(evaluatedAt),
    evidenceEventIds: uniqueIds(Array.isArray(candidate['evidenceEventIds']) ? candidate['evidenceEventIds'] as string[] : []),
    checksPassed: boundedPositive(candidate['checksPassed'], 0, 32),
    checksTotal: boundedPositive(candidate['checksTotal'], 0, 32),
    ...(predictionError === undefined ? {} : { predictionError }),
    ...(boundedText(candidate['summary'], 480) ? { summary: boundedText(candidate['summary'], 480) } : {}),
  };
}

function latestSettlements<T>(
  type: 'sensor_observed' | 'value_evaluated',
  scope: CognitiveScope | undefined,
  parser: (event: CognitiveEvent) => T | null,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const event of listCognitiveEvents({
    ...(scope ? { scope } : {}),
    type,
    order: 'occurred_at_desc',
    limit: 2000,
  })) {
    const value = parser(event);
    if (!value) continue;
    const proposalId = (value as unknown as { proposalId: string }).proposalId;
    if (!out.has(proposalId)) out.set(proposalId, value);
  }
  return out;
}

/** Persist a model-authored read-only observation request. */
export function recordSensorProposal(
  proposal: SensorProposal,
  input: { correlationId?: string; causationId?: string } = {},
): { inserted: boolean; eventId: string } | null {
  const parsed = sensorProposalSchema.safeParse(proposal);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  const sourceEventIds = uniqueIds(parsed.data.sourceEventIds);
  const value: SensorProposal = { ...parsed.data, sourceEventIds };
  const result = appendCognitiveEvent({
    type: 'sensor_proposed',
    source: 'model',
    scope: value.scope,
    ...(input.correlationId ? { correlationId: boundedText(input.correlationId, 240) } : {}),
    ...(input.causationId ? { causationId: boundedText(input.causationId, 240) } : {}),
    dedupeKey: `sensor-proposal:${scopeKey(value.scope)}:${value.method}:${value.question.slice(0, 100)}`.slice(0, 240),
    fact: { schema: value.schema, value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/** Persist a model-authored value/interest hypothesis as a candidate. */
export function recordValueProposal(
  proposal: ValueProposal,
  input: { correlationId?: string; causationId?: string } = {},
): { inserted: boolean; eventId: string } | null {
  const parsed = valueProposalSchema.safeParse(proposal);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  const sourceEventIds = uniqueIds(parsed.data.sourceEventIds);
  const value: ValueProposal = { ...parsed.data, sourceEventIds };
  const result = appendCognitiveEvent({
    type: 'value_proposed',
    source: 'model',
    scope: value.scope,
    ...(input.correlationId ? { correlationId: boundedText(input.correlationId, 240) } : {}),
    ...(input.causationId ? { causationId: boundedText(input.causationId, 240) } : {}),
    dedupeKey: `value-proposal:${scopeKey(value.scope)}:${value.name}:${value.statement.slice(0, 100)}`.slice(0, 240),
    fact: { schema: value.schema, value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/** Host-owned sensor receipt. `verified` requires durable evidence and checks. */
export function recordSensorObservation(input: {
  proposalId: string;
  scope: CognitiveScope;
  status: SensorObservationStatus;
  observedAt?: number;
  evidenceEventIds?: string[];
  checksPassed?: number;
  checksTotal?: number;
  summary?: string;
}): { inserted: boolean; eventId: string; status: SensorObservationStatus } | null {
  if (!validScope(input.scope)) return null;
  const proposal = proposalEvent('sensor_proposed', input.proposalId, input.scope);
  const parsed = proposal ? valueFromEvent(proposal, parseSensorProposal) : null;
  if (!proposal || !parsed || scopeKey(parsed.scope) !== scopeKey(input.scope)) return null;
  const observedAt = boundedPositive(input.observedAt, nowSec(), 4_102_444_800);
  const evidenceEventIds = uniqueIds(input.evidenceEventIds);
  const checksTotal = Math.min(32, Math.max(0, Math.trunc(input.checksTotal ?? 0)));
  const checksPassed = Math.min(checksTotal, Math.max(0, Math.trunc(input.checksPassed ?? 0)));
  const status: SensorObservationStatus = input.status === 'verified'
    && (evidenceEventIds.length === 0 || checksTotal < 1 || checksPassed !== checksTotal)
    ? 'observed'
    : input.status;
  const value: SensorObservation = {
    schema: 'sensor_observation.v1', proposalId: proposal.id, scope: input.scope, status,
    observedAt, evidenceEventIds, checksPassed, checksTotal,
    ...(boundedText(input.summary, 480) ? { summary: boundedText(input.summary, 480) } : {}),
  };
  const result = appendSettlement({
    type: 'sensor_observed', source: 'host', scope: input.scope, proposalId: proposal.id,
    value, occurredAt: observedAt, causationId: proposal.id,
    dedupeKey: `sensor-observation:${proposal.id}:${status}:${observedAt}`,
  });
  return result ? { ...result, status } : null;
}

/** Host-owned evaluation of a value candidate; the model cannot retain itself. */
export function recordValueEvaluation(input: {
  proposalId: string;
  scope: CognitiveScope;
  requestedStatus: ValueEvaluationStatus;
  evaluatedAt?: number;
  evidenceEventIds?: string[];
  checksPassed?: number;
  checksTotal?: number;
  predictionError?: number;
  summary?: string;
}): { inserted: boolean; eventId: string; status: ValueEvaluationStatus } | null {
  if (!validScope(input.scope)) return null;
  const proposal = proposalEvent('value_proposed', input.proposalId, input.scope);
  const parsed = proposal ? valueFromEvent(proposal, parseValueProposal) : null;
  if (!proposal || !parsed || scopeKey(parsed.scope) !== scopeKey(input.scope)) return null;
  const evaluatedAt = boundedPositive(input.evaluatedAt, nowSec(), 4_102_444_800);
  const evidenceEventIds = uniqueIds(input.evidenceEventIds);
  const checksTotal = Math.min(32, Math.max(0, Math.trunc(input.checksTotal ?? 0)));
  const checksPassed = Math.min(checksTotal, Math.max(0, Math.trunc(input.checksPassed ?? 0)));
  const status: ValueEvaluationStatus = input.requestedStatus === 'retained'
    && (evidenceEventIds.length === 0 || checksTotal < 1 || checksPassed !== checksTotal)
    ? 'unverified'
    : input.requestedStatus;
  const predictionError = typeof input.predictionError === 'number' && Number.isFinite(input.predictionError)
    ? Math.min(1, Math.max(0, input.predictionError))
    : undefined;
  const value: ValueEvaluation = {
    schema: 'value_evaluation.v1', proposalId: proposal.id, scope: input.scope, status,
    evaluatedAt, evidenceEventIds, checksPassed, checksTotal,
    ...(predictionError === undefined ? {} : { predictionError }),
    ...(boundedText(input.summary, 480) ? { summary: boundedText(input.summary, 480) } : {}),
  };
  const result = appendSettlement({
    type: 'value_evaluated', source: 'host', scope: input.scope, proposalId: proposal.id,
    value, occurredAt: evaluatedAt, causationId: proposal.id,
    dedupeKey: `value-evaluation:${proposal.id}:${status}:${evaluatedAt}`,
  });
  return result ? { ...result, status } : null;
}

/** Promote only a host-retained, evidence-backed value into the active ledger. */
export function adoptValueProposal(input: {
  proposalId: string;
  scope: CognitiveScope;
  adoptedAt?: number;
  reason?: string;
}): { inserted: boolean; eventId: string } | null {
  if (!validScope(input.scope)) return null;
  const proposal = proposalEvent('value_proposed', input.proposalId, input.scope);
  const parsed = proposal ? valueFromEvent(proposal, parseValueProposal) : null;
  if (!proposal || !parsed || scopeKey(parsed.scope) !== scopeKey(input.scope)) return null;
  const latest = latestSettlements('value_evaluated', input.scope, parseValueEvaluation).get(proposal.id);
  if (!latest || latest.status !== 'retained' || latest.evidenceEventIds.length === 0) return null;
  const adoptedAt = boundedPositive(input.adoptedAt, nowSec(), 4_102_444_800);
  const result = appendCognitiveEvent({
    type: 'value_adopted', source: 'host', scope: input.scope, occurredAt: adoptedAt,
    correlationId: `value:${proposal.id}`, causationId: proposal.id,
    dedupeKey: `value-adopted:${proposal.id}`,
    fact: {
      schema: 'value_adopted.v1',
      value: {
        proposalId: proposal.id, scope: input.scope, adoptedAt,
        evidenceEventIds: latest.evidenceEventIds,
        ...(boundedText(input.reason, 320) ? { reason: boundedText(input.reason, 320) } : {}),
      },
    },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

export function listSensorProposals(scope: CognitiveScope, limit = 16): SensorProposalRecord[] {
  if (!validScope(scope)) return [];
  const observations = latestSettlements('sensor_observed', scope, parseSensorObservation);
  return listCognitiveEvents({
    scope, type: 'sensor_proposed', order: 'occurred_at_desc', limit: Math.min(200, Math.max(1, Math.trunc(limit))),
  }).flatMap((event) => {
    const proposal = valueFromEvent(event, parseSensorProposal);
    if (!proposal || scopeKey(proposal.scope) !== scopeKey(scope)) return [];
    return [{ proposalId: event.id, eventId: event.id, occurredAt: event.occurredAt, proposal, ...(observations.has(event.id) ? { latestObservation: observations.get(event.id) } : {}) }];
  });
}

export function listValueProposals(scope: CognitiveScope, limit = 16): ValueProposalRecord[] {
  if (!validScope(scope)) return [];
  const evaluations = latestSettlements('value_evaluated', scope, parseValueEvaluation);
  const adopted = new Set(
    listCognitiveEvents({ scope, type: 'value_adopted', order: 'occurred_at_desc', limit: 500 })
      .flatMap((event) => {
        const raw = event.fact['value'];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const proposalId = boundedText((raw as Record<string, unknown>)['proposalId'], 240);
        return proposalId ? [proposalId] : [];
      }),
  );
  return listCognitiveEvents({
    scope, type: 'value_proposed', order: 'occurred_at_desc', limit: Math.min(200, Math.max(1, Math.trunc(limit))),
  }).flatMap((event) => {
    const proposal = valueFromEvent(event, parseValueProposal);
    if (!proposal || scopeKey(proposal.scope) !== scopeKey(scope)) return [];
    return [{ proposalId: event.id, eventId: event.id, occurredAt: event.occurredAt, proposal, ...(evaluations.has(event.id) ? { latestEvaluation: evaluations.get(event.id) } : {}), adopted: adopted.has(event.id) }];
  });
}
