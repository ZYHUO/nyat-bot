// Durable projections for NyatOS state contracts.
//
// These helpers keep the model-facing concepts (inner state, affect, missions
// and capabilities) on the same append-only event ledger as Telegram facts.
// They are proposal/observation stores only: none of them dispatches a tool or
// promotes a model claim into verified reality.

import {
  appendCognitiveEvent,
  listCognitiveEvents,
  type CognitiveEvent,
  type CognitiveEventSource,
} from './cognitive-events.js';
import {
  affectEpisodeSchema,
  capabilitySnapshotSchema,
  innerStateSchema,
  missionProposalSchema,
  parseAffectEpisode,
  parseCapabilitySnapshot,
  parseInnerState,
  parseMissionProposal,
  type AffectEpisode,
  type CapabilitySnapshot,
  type InnerState,
  type MissionProposal,
} from './nyatos-contracts.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';

export interface NyatosStateRecord<T> {
  eventId: string;
  scopeKey: string;
  occurredAt: number;
  value: T;
}

function validScope(scope: CognitiveScope): boolean {
  try {
    scopeKey(scope);
    return true;
  } catch {
    return false;
  }
}

function boundedId(value: string | undefined, max = 240): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function recordValue<T>(input: {
  type: 'inner_state_updated' | 'affect_episode_updated' | 'mission_proposed' | 'capability_observed';
  source: CognitiveEventSource;
  scope: CognitiveScope;
  value: T;
  schema: string;
  dedupeKey: string;
  correlationId?: string;
  causationId?: string;
  occurredAt?: number;
}): { inserted: boolean; eventId: string } | null {
  if (!validScope(input.scope)) return null;
  const result = appendCognitiveEvent({
    type: input.type,
    source: input.source,
    scope: input.scope,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(boundedId(input.causationId) ? { causationId: boundedId(input.causationId) } : {}),
    correlationId: boundedId(input.correlationId) ?? `nyatos:${scopeKey(input.scope)}`,
    dedupeKey: input.dedupeKey.slice(0, 240),
    fact: { schema: input.schema, value: input.value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/** Store a host-derived inner state snapshot. */
export function recordInnerState(
  state: InnerState,
  input: {
    scope: CognitiveScope;
    correlationId?: string;
    causationId?: string;
    occurredAt?: number;
  },
): { inserted: boolean; eventId: string } | null {
  const parsed = innerStateSchema.safeParse(state);
  if (!parsed.success || !validScope(input.scope)) return null;
  const occurredAt = input.occurredAt ?? parsed.data.updatedAt;
  const anchor = boundedId(input.causationId) ?? boundedId(input.correlationId) ?? String(occurredAt);
  return recordValue({
    type: 'inner_state_updated',
    source: 'host',
    scope: input.scope,
    value: parsed.data,
    schema: parsed.data.schema,
    dedupeKey: `inner-state:${scopeKey(input.scope)}:${anchor}`,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    occurredAt,
  });
}

/** Return the newest valid inner-state snapshot for a scope. */
export function getLatestInnerState(scope: CognitiveScope): NyatosStateRecord<InnerState> | null {
  if (!validScope(scope)) return null;
  const event = listCognitiveEvents({
    scope,
    type: 'inner_state_updated',
    order: 'occurred_at_desc',
    limit: 32,
  })
    .map((candidate) => ({ candidate, value: parseInnerState(candidate.fact['value']) }))
    .find((item): item is { candidate: CognitiveEvent; value: InnerState } => item.value !== null);
  if (!event) return null;
  return {
    eventId: event.candidate.id,
    scopeKey: event.candidate.scopeKey,
    occurredAt: event.candidate.occurredAt,
    value: event.value,
  };
}

/** Store a scoped affect episode as a model/host proposal with provenance. */
export function recordAffectEpisode(
  episode: AffectEpisode,
  input: {
    source?: Extract<CognitiveEventSource, 'host' | 'model' | 'scheduler'>;
    correlationId?: string;
    causationId?: string;
  } = {},
): { inserted: boolean; eventId: string } | null {
  const parsed = affectEpisodeSchema.safeParse(episode);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  return recordValue({
    type: 'affect_episode_updated',
    source: input.source ?? 'model',
    scope: parsed.data.scope,
    value: parsed.data,
    schema: parsed.data.schema,
    dedupeKey: `affect:${parsed.data.scope ? scopeKey(parsed.data.scope) : 'global'}:${parsed.data.id}:${parsed.data.updatedAt}`,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    occurredAt: parsed.data.updatedAt,
  });
}

/** List valid affect episodes for one exact scope, newest first. */
export function listAffectEpisodes(scope: CognitiveScope, limit = 32): NyatosStateRecord<AffectEpisode>[] {
  if (!validScope(scope)) return [];
  return listCognitiveEvents({
    scope,
    type: 'affect_episode_updated',
    order: 'occurred_at_desc',
    limit: Math.min(200, Math.max(1, Math.trunc(limit))),
  })
    .map((event) => ({ event, value: parseAffectEpisode(event.fact['value']) }))
    .filter((item): item is { event: CognitiveEvent; value: AffectEpisode } => item.value !== null)
    .filter((item) => {
      try { return scopeKey(item.value.scope) === scopeKey(scope); } catch { return false; }
    })
    .map(({ event, value }) => ({
      eventId: event.id,
      scopeKey: event.scopeKey,
      occurredAt: event.occurredAt,
      value,
    }));
}

/** Store a model mission proposal; completion remains host-evidence gated. */
export function recordMissionProposal(
  proposal: MissionProposal,
  input: {
    source?: Extract<CognitiveEventSource, 'host' | 'model' | 'scheduler'>;
    correlationId?: string;
    causationId?: string;
  } = {},
): { inserted: boolean; eventId: string } | null {
  const parsed = missionProposalSchema.safeParse(proposal);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  return recordValue({
    type: 'mission_proposed',
    source: input.source ?? 'model',
    scope: parsed.data.scope,
    value: parsed.data,
    schema: parsed.data.schema,
    dedupeKey: `mission:${scopeKey(parsed.data.scope)}:${parsed.data.objective.slice(0, 120)}:${parsed.data.deadlineAt ?? 'open'}`,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
  });
}

/** List bounded mission proposals for an exact scope, newest first. */
export function listMissionProposals(scope: CognitiveScope, limit = 8): NyatosStateRecord<MissionProposal>[] {
  if (!validScope(scope)) return [];
  return listCognitiveEvents({
    scope,
    type: 'mission_proposed',
    order: 'occurred_at_desc',
    limit: Math.min(200, Math.max(1, Math.trunc(limit))),
  })
    .map((event) => ({ event, value: parseMissionProposal(event.fact['value']) }))
    .filter((item): item is { event: CognitiveEvent; value: MissionProposal } => item.value !== null)
    .filter((item) => {
      try { return scopeKey(item.value.scope) === scopeKey(scope); } catch { return false; }
    })
    .map(({ event, value }) => ({
      eventId: event.id,
      scopeKey: event.scopeKey,
      occurredAt: event.occurredAt,
      value,
    }));
}

/** Store a host-observed capability snapshot. */
export function recordCapabilitySnapshot(
  snapshot: CapabilitySnapshot,
  input: { correlationId?: string; causationId?: string } = {},
): { inserted: boolean; eventId: string } | null {
  const parsed = capabilitySnapshotSchema.safeParse(snapshot);
  if (!parsed.success || !validScope(parsed.data.scope)) return null;
  // Capability observations are snapshots, not per-message facts. Reusing the
  // observed timestamp/thread as the dedupe anchor keeps a cached host probe
  // from creating one identical row for every Telegram update.
  const anchor = `${parsed.data.observedAt}:${parsed.data.threadId ?? 'general'}`;
  return recordValue({
    type: 'capability_observed',
    source: 'host',
    scope: parsed.data.scope,
    value: parsed.data,
    schema: parsed.data.schema,
    dedupeKey: `capability:${scopeKey(parsed.data.scope)}:${anchor}`,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    occurredAt: parsed.data.observedAt,
  });
}

/** Return the newest valid host capability snapshot for a scope. */
export function getLatestCapabilitySnapshot(scope: CognitiveScope): NyatosStateRecord<CapabilitySnapshot> | null {
  if (!validScope(scope)) return null;
  const event = listCognitiveEvents({
    scope,
    type: 'capability_observed',
    order: 'occurred_at_desc',
    limit: 32,
  })
    .map((candidate) => ({ candidate, value: parseCapabilitySnapshot(candidate.fact['value']) }))
    .find((item): item is { candidate: CognitiveEvent; value: CapabilitySnapshot } => item.value !== null);
  if (!event) return null;
  return {
    eventId: event.candidate.id,
    scopeKey: event.candidate.scopeKey,
    occurredAt: event.candidate.occurredAt,
    value: event.value,
  };
}
