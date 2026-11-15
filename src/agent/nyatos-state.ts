// Durable projections for NyatOS state contracts.
//
// These helpers keep the model-facing concepts (inner state, affect, missions
// and capabilities) on the same append-only event ledger as Telegram facts.
// They are proposal/observation stores only: none of them dispatches a tool or
// promotes a model claim into verified reality.

import {
  appendCognitiveEvent,
  getCognitiveEvent,
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
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { createHash } from 'node:crypto';

export interface NyatosStateRecord<T> {
  eventId: string;
  scopeKey: string;
  occurredAt: number;
  value: T;
  source?: CognitiveEventSource;
}

function emotionSourceMatches(event: CognitiveEvent, scope: CognitiveScope): boolean {
  if (!env().EMOTION_CONTINUITY_ENABLED) return true;
  if (scope.visibility !== 'chat' || scope.chatId === undefined) return false;
  const target = resolveConversationScope(scope.chatId);
  const source = event.fact['conversationScope'] as Record<string, unknown> | undefined;
  return !!target?.accountId && !!source && source['chatId'] === target.chatId
    && source['platform'] === target.platform && source['accountId'] === target.accountId
    && source['conversationKind'] === target.conversationKind;
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
  const emotion = input.type === 'inner_state_updated' || input.type === 'affect_episode_updated';
  const conversation = emotion && env().EMOTION_CONTINUITY_ENABLED && input.scope.chatId !== undefined
    ? resolveConversationScope(input.scope.chatId) : null;
  if (emotion && env().EMOTION_CONTINUITY_ENABLED && !conversation?.accountId) return null;
  const result = appendCognitiveEvent({
    type: input.type,
    source: input.source,
    scope: input.scope,
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(boundedId(input.causationId) ? { causationId: boundedId(input.causationId) } : {}),
    correlationId: boundedId(input.correlationId) ?? `nyatos:${scopeKey(input.scope)}`,
    dedupeKey: input.dedupeKey.slice(0, 240),
    fact: { schema: input.schema, value: input.value, ...(conversation ? { conversationScope: conversation } : {}) },
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
export function getLatestInnerState(scope: CognitiveScope, asOfSec = Math.floor(Date.now() / 1000)): NyatosStateRecord<InnerState> | null {
  if (!validScope(scope)) return null;
  if (!Number.isSafeInteger(asOfSec) || asOfSec <= 0) return null;
  const rows = getDb().prepare(`SELECT id FROM cognitive_events WHERE scope_key = ? AND type = 'inner_state_updated'
    AND occurred_at <= ? ORDER BY occurred_at DESC, rowid DESC LIMIT 32`).all(scopeKey(scope), asOfSec) as { id: string }[];
  const event = rows.map((row) => getCognitiveEvent(row.id)).filter((event): event is CognitiveEvent => event !== null)
    .filter((candidate) => candidate.source === 'host' && emotionSourceMatches(candidate, scope))
    .map((candidate) => ({ candidate, value: parseInnerState(candidate.fact['value']) }))
    .find((item): item is { candidate: CognitiveEvent; value: InnerState } => item.value !== null);
  if (!event) return null;
  return {
    eventId: event.candidate.id,
    scopeKey: event.candidate.scopeKey,
    occurredAt: event.candidate.occurredAt,
    value: event.value,
    source: event.candidate.source,
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
  if (parsed.data.updatedAt < parsed.data.startedAt) return null;
  try {
    return getDb().transaction(() => {
      const row = getDb().prepare(`SELECT id FROM cognitive_events WHERE type = 'affect_episode_updated' AND scope_key = ?
        AND json_valid(fact_json) AND json_extract(fact_json, '$.value.id') = ?
        ORDER BY occurred_at DESC, rowid DESC LIMIT 1`).get(scopeKey(parsed.data.scope), parsed.data.id) as { id: string } | undefined;
      const previous = row ? getCognitiveEvent(row.id) : null;
      const value = previous ? parseAffectEpisode(previous.fact['value']) : null;
      if (value && (value.updatedAt > parsed.data.updatedAt
        || (value.status !== 'active' && parsed.data.status === 'active'))) return null;
      const revision = createHash('sha256').update(JSON.stringify([scopeKey(parsed.data.scope), parsed.data])).digest('hex');
      return recordValue({
        type: 'affect_episode_updated',
        source: input.source ?? 'model',
        scope: parsed.data.scope,
        value: parsed.data,
        schema: parsed.data.schema,
        dedupeKey: `affect:${revision}`,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        occurredAt: parsed.data.updatedAt,
      });
    }).immediate();
  } catch { return null; }
}

/** List valid affect episodes for one exact scope, newest first. */
export function listAffectEpisodes(scope: CognitiveScope, limit = 32, asOfSec = Math.floor(Date.now() / 1000)): NyatosStateRecord<AffectEpisode>[] {
  if (!validScope(scope)) return [];
  if (!Number.isSafeInteger(asOfSec) || asOfSec <= 0) return [];
  // Rank versions before applying the result limit. A resolved/superseded (or
  // malformed newest) revision must hide its old active revision permanently.
  const rows = getDb().prepare(`SELECT id FROM (
    SELECT id, occurred_at, rowid AS event_rowid,
      ROW_NUMBER() OVER (PARTITION BY json_extract(fact_json, '$.value.id') ORDER BY occurred_at DESC, rowid DESC) AS version
    FROM cognitive_events WHERE scope_key = ? AND type = 'affect_episode_updated'
      AND occurred_at <= ? AND json_valid(fact_json)
  ) WHERE version = 1 ORDER BY occurred_at DESC, event_rowid DESC LIMIT ?`).all(
    scopeKey(scope), asOfSec, Math.min(200, Math.max(1, Math.trunc(limit))),
  ) as { id: string }[];
  return rows.map((row) => getCognitiveEvent(row.id)).filter((event): event is CognitiveEvent => event !== null)
    .filter((event) => emotionSourceMatches(event, scope))
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
      source: event.source,
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
