// Durable continuity for model-authored missions and long-lived cognitive
// processes.  The ledger stores proposals, wake requests, and host outcomes;
// it never executes a tool or treats model text as proof.

import { appendCognitiveEvent, getCognitiveEvent } from './cognitive-events.js';
import { iterateCognitiveHistory } from './cognitive-history.js';
import type { CognitiveEvent, CognitiveEventSource } from './cognitive-events.js';
import { parseMissionProposal, type MissionProposal } from './nyatos-contracts.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';
import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';

export type MissionLifecycle = 'proposed' | 'wake_requested' | 'observed' | 'verified' | 'failed' | 'stopped' | 'expired';
export type MissionObservationStatus = Exclude<MissionLifecycle, 'proposed'>;

export interface MissionObservation {
  schema: 'mission_observation.v1';
  missionId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  status: MissionObservationStatus;
  observedAt: number;
  evidenceEventIds: string[];
  checksPassed: number;
  checksTotal: number;
  summary?: string;
  nextWakeAt?: number;
}

export interface MissionContinuity {
  missionId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  proposal: MissionProposal;
  proposedAt: number;
  status: MissionLifecycle;
  lastEventId: string;
  lastEventAt: number;
  nextWakeAt?: number;
  due: boolean;
  evidenceEventIds: string[];
  checksPassed: number;
  checksTotal: number;
}

export interface MissionWake {
  missionId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  wakeEventId: string;
  wakeAt: number;
  reason: string;
}

export type CognitiveProcessKind = 'observer' | 'social_mind' | 'strategist' | 'skeptic' | 'memory_curator';
export type CognitiveProcessCheckpointStatus = 'completed' | 'failed' | 'waiting';

export interface ProcessWakeRequest {
  schema: 'cognitive_process_wake.v1';
  processId: string;
  kind: CognitiveProcessKind;
  scope: CognitiveScope;
  wakeAt: number;
  reason: string;
  causeEventIds: string[];
}

export interface ProcessWake {
  processId: string;
  kind: CognitiveProcessKind;
  scope: CognitiveScope;
  wakeEventId: string;
  wakeAt: number;
  reason: string;
  causeEventIds: string[];
}

export interface ProcessCheckpoint {
  schema: 'cognitive_process_checkpoint.v1';
  processId: string;
  wakeEventId: string;
  scope: CognitiveScope;
  status: CognitiveProcessCheckpointStatus;
  recordedAt: number;
  nextWakeAt?: number;
  outcomeEventIds: string[];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function validChatScope(scope: CognitiveScope): scope is CognitiveScope & { visibility: 'chat'; chatId: number } {
  return scope.visibility === 'chat' && Number.isSafeInteger(scope.chatId) && scope.chatId !== 0;
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

function valueOf<T>(event: CognitiveEvent, parser: (value: unknown) => T | null): T | null {
  return parser(event.fact['value']);
}

function eventForMission(missionId: string, scope?: CognitiveScope): CognitiveEvent | null {
  const normalized = boundedText(missionId, 240);
  if (!normalized) return null;
  const event = getCognitiveEvent(normalized);
  return event?.type === 'mission_proposed' && (!scope || event.scopeKey === scopeKey(scope)) ? event : null;
}

function appendMissionEvent(input: {
  type: 'mission_observed' | 'mission_wake_requested';
  source: Extract<CognitiveEventSource, 'host' | 'scheduler'>;
  missionId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  value: MissionObservation | { schema: 'mission_wake.v1'; missionId: string; scope: MissionObservation['scope']; wakeAt: number; reason: string };
  occurredAt: number;
  dedupeKey: string;
  causationId?: string;
}): { inserted: boolean; eventId: string } | null {
  const result = appendCognitiveEvent({
    type: input.type,
    source: input.source,
    scope: input.scope,
    occurredAt: input.occurredAt,
    correlationId: `mission:${input.missionId}`,
    dedupeKey: input.dedupeKey.slice(0, 240),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    fact: { schema: input.value.schema, value: input.value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

function latestMissionEvents(scope?: CognitiveScope): CognitiveEvent[] {
  return [...iterateCognitiveHistory({
    ...(scope ? { scope } : {}),
    type: 'mission_observed',
  })];
}

function parseMissionObservation(event: CognitiveEvent): MissionObservation | null {
  const value = event.fact['value'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate['scope'];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const scopeValue = scope as Record<string, unknown>;
  if (scopeValue['visibility'] !== 'chat' || !Number.isSafeInteger(scopeValue['chatId']) || scopeValue['chatId'] === 0) return null;
  const status = candidate['status'];
  if (!['wake_requested', 'observed', 'verified', 'failed', 'stopped', 'expired'].includes(String(status))) return null;
  const observedAt = candidate['observedAt'];
  if (!Number.isSafeInteger(observedAt) || Number(observedAt) <= 0) return null;
  const evidenceEventIds = uniqueIds(Array.isArray(candidate['evidenceEventIds']) ? candidate['evidenceEventIds'] as string[] : []);
  const checksPassed = boundedPositive(candidate['checksPassed'], 0, 8);
  const checksTotal = boundedPositive(candidate['checksTotal'], 0, 8);
  return {
    schema: 'mission_observation.v1',
    missionId: boundedText(candidate['missionId'], 240),
    scope: scopeValue as unknown as MissionObservation['scope'],
    status: status as MissionObservationStatus,
    observedAt: Number(observedAt),
    evidenceEventIds,
    checksPassed,
    checksTotal,
    ...(boundedText(candidate['summary'], 400) ? { summary: boundedText(candidate['summary'], 400) } : {}),
    ...(Number.isSafeInteger(candidate['nextWakeAt']) && Number(candidate['nextWakeAt']) > 0
      ? { nextWakeAt: Number(candidate['nextWakeAt']) }
      : {}),
  };
}

function parseMissionWake(event: CognitiveEvent): MissionObservation | null {
  if (event.type !== 'mission_wake_requested') return null;
  const value = event.fact['value'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate['scope'];
  const missionId = boundedText(candidate['missionId'], 240);
  const wakeAt = candidate['wakeAt'];
  const reason = boundedText(candidate['reason'], 240);
  if (!missionId || !scope || typeof scope !== 'object' || Array.isArray(scope)
    || !Number.isSafeInteger(wakeAt) || Number(wakeAt) <= 0 || !reason || !validChatScope(scope as CognitiveScope)) return null;
  return {
    schema: 'mission_observation.v1',
    missionId,
    scope: scope as MissionObservation['scope'],
    status: 'wake_requested',
    observedAt: event.occurredAt,
    evidenceEventIds: [event.id],
    checksPassed: 0,
    checksTotal: 0,
    summary: reason,
    // Leave a quiet hour between retries when a worker has not consumed the
    // wake. A later host observation can override this with its own schedule.
    nextWakeAt: Math.min(4_102_444_800, Number(wakeAt) + 3600),
  };
}

function latestObservationByMission(scope?: CognitiveScope): Map<string, { event: CognitiveEvent; value: MissionObservation }> {
  const out = new Map<string, { event: CognitiveEvent; value: MissionObservation }>();
  const events = [
    ...latestMissionEvents(scope),
    ...iterateCognitiveHistory({
      ...(scope ? { scope } : {}),
      type: 'mission_wake_requested',
    }),
  ].sort((a, b) => b.occurredAt - a.occurredAt || b.sequence - a.sequence || b.id.localeCompare(a.id));
  for (const event of events) {
    const value = event.type === 'mission_wake_requested' ? parseMissionWake(event) : parseMissionObservation(event);
    if (!value || !value.missionId || event.scopeKey !== scopeKey(value.scope)) continue;
    const key = JSON.stringify([event.scopeKey, value.missionId]);
    if (out.has(key)) continue;
    out.set(key, { event, value });
  }
  return out;
}

function missionContinuityFromProposal(
  event: CognitiveEvent,
  observation: { event: CognitiveEvent; value: MissionObservation } | undefined,
  now = nowSec(),
): MissionContinuity | null {
  const proposal = valueOf(event, parseMissionProposal);
  if (!proposal || !validChatScope(proposal.scope)) return null;
  const lastEvent = observation?.event ?? event;
  const status: MissionLifecycle = observation?.value.status ?? 'proposed';
  const nextWakeAt = observation?.value.nextWakeAt ?? proposal.nextWakeAt;
  const terminal = status === 'verified' || status === 'failed' || status === 'stopped' || status === 'expired';
  return {
    missionId: event.id,
    scope: proposal.scope,
    proposal,
    proposedAt: event.occurredAt,
    status,
    lastEventId: lastEvent.id,
    lastEventAt: lastEvent.occurredAt,
    ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
    due: !terminal && (nextWakeAt === undefined || nextWakeAt <= now),
    evidenceEventIds: observation?.value.evidenceEventIds ?? [],
    checksPassed: observation?.value.checksPassed ?? 0,
    checksTotal: observation?.value.checksTotal ?? 0,
  };
}

/** Read proposals plus their latest host/scheduler observation, exact-scope only. */
export function listMissionContinuity(scope?: CognitiveScope, limit = 100): MissionContinuity[] {
  if (scope && !validChatScope(scope)) return [];
  const observations = latestObservationByMission(scope);
  return [...iterateCognitiveHistory({
    ...(scope ? { scope } : {}),
    type: 'mission_proposed',
  })]
    .map((event) => missionContinuityFromProposal(event, observations.get(JSON.stringify([event.scopeKey, event.id]))))
    .filter((mission): mission is MissionContinuity => mission !== null)
    .sort((a, b) => b.proposedAt - a.proposedAt || b.missionId.localeCompare(a.missionId))
    .slice(0, Math.max(1, Math.trunc(limit)));
}

export function getMissionContinuity(missionId: string, scope?: CognitiveScope): MissionContinuity | null {
  const proposal = eventForMission(missionId, scope);
  if (!proposal) return null;
  const observation = latestObservationByMission(scope).get(JSON.stringify([proposal.scopeKey, proposal.id]));
  return missionContinuityFromProposal(proposal, observation);
}

/** Host-owned outcome. A model cannot call this API through the Meta tool surface. */
export function recordMissionObservation(input: {
  missionId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  status: Exclude<MissionObservationStatus, 'wake_requested'>;
  observedAt?: number;
  evidenceEventIds?: string[];
  checksPassed?: number;
  checksTotal?: number;
  summary?: string;
  nextWakeAt?: number;
}): { inserted: boolean; eventId: string } | null {
  if (!validChatScope(input.scope)) return null;
  const mission = eventForMission(input.missionId, input.scope);
  if (!mission) return null;
  const proposal = valueOf(mission, parseMissionProposal);
  if (!proposal || !validChatScope(proposal.scope) || scopeKey(proposal.scope) !== scopeKey(input.scope)) return null;
  const observedAt = boundedPositive(input.observedAt, nowSec(), 4_102_444_800);
  const checksTotal = Math.min(8, Math.max(0, Math.trunc(input.checksTotal ?? 0)));
  const checksPassed = Math.min(checksTotal, Math.max(0, Math.trunc(input.checksPassed ?? 0)));
  const evidenceEventIds = uniqueIds(input.evidenceEventIds);
  // Verified means all caller/host checks passed and at least one durable fact
  // points at the result. Otherwise the observation remains non-terminal.
  const status = input.status === 'verified' && (checksTotal < 1 || checksPassed !== checksTotal || evidenceEventIds.length === 0)
    ? 'observed'
    : input.status;
  const value: MissionObservation = {
    schema: 'mission_observation.v1',
    missionId: mission.id,
    scope: input.scope,
    status,
    observedAt,
    evidenceEventIds,
    checksPassed,
    checksTotal,
    ...(boundedText(input.summary, 400) ? { summary: boundedText(input.summary, 400) } : {}),
    ...(input.nextWakeAt !== undefined && Number.isSafeInteger(input.nextWakeAt) && input.nextWakeAt > observedAt
      ? { nextWakeAt: Math.min(4_102_444_800, input.nextWakeAt) }
      : {}),
  };
  return appendMissionEvent({
    type: 'mission_observed',
    source: 'host',
    missionId: mission.id,
    scope: input.scope,
    value,
    occurredAt: observedAt,
    causationId: mission.id,
    dedupeKey: `mission-observation:${mission.id}:${status}:${observedAt}`,
  });
}

/** Scheduler-owned durable wake request. It does not create a goal or run a tool. */
export function requestMissionWake(input: {
  missionId: string;
  scope: CognitiveScope & { visibility: 'chat'; chatId: number };
  wakeAt?: number;
  reason?: string;
}): { inserted: boolean; eventId: string; wakeAt: number } | null {
  if (!validChatScope(input.scope)) return null;
  const mission = getMissionContinuity(input.missionId, input.scope);
  if (!mission || mission.status === 'verified' || mission.status === 'failed' || mission.status === 'stopped' || mission.status === 'expired') return null;
  const wakeAt = boundedPositive(input.wakeAt, nowSec(), 4_102_444_800);
  const reason = boundedText(input.reason, 240) || 'mission_due';
  const value = {
    schema: 'mission_wake.v1' as const,
    missionId: mission.missionId,
    scope: mission.scope,
    wakeAt,
    reason,
  };
  const result = appendMissionEvent({
    type: 'mission_wake_requested',
    source: 'scheduler',
    missionId: mission.missionId,
    scope: mission.scope,
    value,
    occurredAt: nowSec(),
    causationId: mission.lastEventId,
    dedupeKey: `mission-wake:${mission.missionId}:${Math.floor(wakeAt / 60)}`,
  });
  return result ? { inserted: result.inserted, eventId: result.eventId, wakeAt } : null;
}

/** Claim due mission proposals without executing them. Repeated ticks are idempotent per minute. */
export function claimDueMissionWakes(now = nowSec(), limit = 20): MissionWake[] {
  const wakes: MissionWake[] = [];
  const due = listMissionContinuity(undefined, Number.POSITIVE_INFINITY)
    .filter(item => !['verified', 'failed', 'stopped', 'expired'].includes(item.status) && (item.nextWakeAt ?? 0) <= now)
    .filter(item => {
      // Operator-owned digital projects have a precise, budgeted scheduler.
      // A second minute-based mission_due wake must not compete with it. This
      // also recognizes existing activations, without relabelling old events.
      const proposal = getCognitiveEvent(item.missionId);
      const activation = proposal?.source === 'host' && proposal.causationId
        ? getCognitiveEvent(proposal.causationId) : null;
      return activation?.source !== 'host' || activation.fact['kind'] !== 'operator_activated_digital_project';
    })
    .sort((a, b) => (a.nextWakeAt ?? a.proposedAt) - (b.nextWakeAt ?? b.proposedAt) || a.missionId.localeCompare(b.missionId));
  for (const mission of due.slice(0, Math.min(100, Math.max(1, Math.trunc(limit))))) {
    const requested = requestMissionWake({ missionId: mission.missionId, scope: mission.scope, wakeAt: now, reason: 'mission_due' });
    if (!requested?.inserted) continue;
    wakes.push({
      missionId: mission.missionId,
      scope: mission.scope,
      wakeEventId: requested.eventId,
      wakeAt: requested.wakeAt,
      reason: 'mission_due',
    });
  }
  return wakes;
}

export function stopMission(input: { missionId: string; scope: CognitiveScope & { visibility: 'chat'; chatId: number }; summary?: string }): { inserted: boolean; eventId: string } | null {
  return recordMissionObservation({ ...input, status: 'stopped', summary: input.summary ?? 'stopped_by_host' });
}

function parseProcessWake(event: CognitiveEvent): ProcessWakeRequest | null {
  const value = event.fact['value'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate['scope'];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const kind = candidate['kind'];
  if (!['observer', 'social_mind', 'strategist', 'skeptic', 'memory_curator'].includes(String(kind))) return null;
  const wakeAt = candidate['wakeAt'];
  const processId = boundedText(candidate['processId'], 160);
  const reason = boundedText(candidate['reason'], 240);
  if (!processId || !reason || !Number.isSafeInteger(wakeAt) || Number(wakeAt) <= 0) return null;
  let normalizedScope: CognitiveScope;
  try {
    scopeKey(scope as CognitiveScope);
    normalizedScope = scope as CognitiveScope;
  } catch {
    return null;
  }
  return {
    schema: 'cognitive_process_wake.v1',
    processId,
    kind: kind as CognitiveProcessKind,
    scope: normalizedScope,
    wakeAt: Number(wakeAt),
    reason,
    causeEventIds: uniqueIds(Array.isArray(candidate['causeEventIds']) ? candidate['causeEventIds'] as string[] : []),
  };
}

function parseProcessCheckpoint(event: CognitiveEvent): ProcessCheckpoint | null {
  const value = event.fact['value'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const processId = boundedText(candidate['processId'], 160);
  const wakeEventId = boundedText(candidate['wakeEventId'], 240);
  const status = candidate['status'];
  const scope = candidate['scope'];
  const recordedAt = candidate['recordedAt'];
  if (!processId || !wakeEventId || !['completed', 'failed', 'waiting'].includes(String(status)) || !scope || typeof scope !== 'object' || Array.isArray(scope) || !Number.isSafeInteger(recordedAt)) return null;
  try { scopeKey(scope as CognitiveScope); } catch { return null; }
  return {
    schema: 'cognitive_process_checkpoint.v1',
    processId,
    wakeEventId,
    scope: scope as CognitiveScope,
    status: status as CognitiveProcessCheckpointStatus,
    recordedAt: Number(recordedAt),
    ...(Number.isSafeInteger(candidate['nextWakeAt']) && Number(candidate['nextWakeAt']) > 0 ? { nextWakeAt: Number(candidate['nextWakeAt']) } : {}),
    outcomeEventIds: uniqueIds(Array.isArray(candidate['outcomeEventIds']) ? candidate['outcomeEventIds'] as string[] : []),
  };
}

function processCheckpoints(): Map<string, ProcessCheckpoint> {
  const map = new Map<string, ProcessCheckpoint>();
  for (const event of iterateCognitiveHistory({ type: 'cognitive_process_checkpoint' })) {
    const checkpoint = parseProcessCheckpoint(event);
    if (checkpoint && event.scopeKey === scopeKey(checkpoint.scope)) map.set(checkpoint.wakeEventId, checkpoint);
  }
  return map;
}

/** The source is a persisted host snapshot, never inferred from today's token. */
export function hasCurrentProcessWakeSource(event: CognitiveEvent | null): boolean {
  if (!event || event.type !== 'cognitive_process_wake' || event.source !== 'scheduler'
    || event.visibility !== 'chat' || event.chatId === null) return false;
  const target = resolveConversationScope(event.chatId);
  const source = event.fact['conversationScope'];
  if (!target?.accountId || !source || typeof source !== 'object' || Array.isArray(source)) return false;
  const saved = source as Record<string, unknown>;
  return saved['chatId'] === target.chatId && saved['platform'] === target.platform
    && saved['accountId'] === target.accountId && saved['conversationKind'] === target.conversationKind;
}

/** Persist a process wake-up; a lease/checkpoint is required before it is considered consumed. */
export function requestProcessWake(input: {
  processId: string;
  kind: CognitiveProcessKind;
  scope: CognitiveScope;
  wakeAt?: number;
  reason: string;
  causeEventIds?: string[];
  dedupePrecision?: 'second';
}): { inserted: boolean; eventId: string; wakeAt: number } | null {
  let key: string;
  try { key = scopeKey(input.scope); } catch { return null; }
  const processId = boundedText(input.processId, 160);
  const reason = boundedText(input.reason, 240);
  if (!processId || !reason || !['observer', 'social_mind', 'strategist', 'skeptic', 'memory_curator'].includes(input.kind)) return null;
  const wakeAt = boundedPositive(input.wakeAt, nowSec(), 4_102_444_800);
  const conversation = input.scope.visibility === 'chat' && input.scope.chatId !== undefined
    ? resolveConversationScope(input.scope.chatId) : null;
  if (env().EMOTION_CONTINUITY_ENABLED && input.scope.visibility === 'chat' && !conversation?.accountId) return null;
  const value: ProcessWakeRequest = {
    schema: 'cognitive_process_wake.v1', processId, kind: input.kind, scope: input.scope, wakeAt, reason,
    causeEventIds: uniqueIds(input.causeEventIds),
  };
  // Account changes must not alias an older wake in the same minute. Keep the
  // legacy key while continuity is off; new account-bound keys are bounded.
  const dedupeKey = input.dedupePrecision === 'second'
    ? `process-wake:exact:${createHash('sha256').update(JSON.stringify([key, processId, wakeAt, conversation])).digest('hex')}`
    : env().EMOTION_CONTINUITY_ENABLED && conversation?.accountId
      ? `process-wake:v2:${createHash('sha256').update(JSON.stringify([key, processId, Math.floor(wakeAt / 60), conversation])).digest('hex')}`
      : `process-wake:${key}:${processId}:${Math.floor(wakeAt / 60)}`;
  const result = appendCognitiveEvent({
    type: 'cognitive_process_wake', source: 'scheduler', scope: input.scope, occurredAt: nowSec(),
    correlationId: `process:${processId}`, dedupeKey,
    fact: { schema: value.schema, value, ...(conversation?.accountId ? { conversationScope: conversation } : {}) },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id, wakeAt } : null;
}

function* pendingProcessWakes(): Generator<ProcessWake> {
  const checkpoints = processCheckpoints();
  const stoppedAt = new Map<string, number>();
  for (const event of iterateCognitiveHistory({ type: 'cognitive_process_stopped' })) {
    const value = event.fact['value'];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const processId = boundedText(candidate['processId'], 160);
    if (processId) stoppedAt.set(JSON.stringify([event.scopeKey, processId]), event.occurredAt);
  }
  for (const event of iterateCognitiveHistory({ type: 'cognitive_process_wake' })) {
    const value = parseProcessWake(event);
    if (!value || event.scopeKey !== scopeKey(value.scope)) continue;
    if (env().EMOTION_CONTINUITY_ENABLED && value.scope.visibility === 'chat' && !hasCurrentProcessWakeSource(event)) continue;
    const checkpoint = checkpoints.get(event.id);
    if (checkpoint && scopeKey(checkpoint.scope) === event.scopeKey && checkpoint.processId === value.processId) continue;
    if ((stoppedAt.get(JSON.stringify([event.scopeKey, value.processId])) ?? -1) >= event.occurredAt) continue;
    yield {
      processId: value.processId, kind: value.kind, scope: value.scope, wakeEventId: event.id,
      wakeAt: value.wakeAt, reason: value.reason, causeEventIds: value.causeEventIds,
    };
  }
}

/** Includes future pending wakes, so a host driver can retire superseded work. */
export function listPendingProcessWakes(): ProcessWake[] {
  return [...pendingProcessWakes()];
}

export function listDueProcessWakes(now = nowSec(), limit = 50, eligible?: (wake: ProcessWake) => boolean): ProcessWake[] {
  const out: ProcessWake[] = [];
  for (const wake of pendingProcessWakes()) {
    // Driver eligibility is applied before LIMIT, never after a stale process
    // has already consumed the entire bounded execution window.
    if (wake.wakeAt > now || (eligible && !eligible(wake))) continue;
    out.push(wake);
    if (out.length >= Math.min(100, Math.max(1, Math.trunc(limit)))) break;
  }
  return out;
}

export function checkpointProcess(input: {
  processId: string;
  wakeEventId: string;
  scope: CognitiveScope;
  status: CognitiveProcessCheckpointStatus;
  nextWakeAt?: number;
  outcomeEventIds?: string[];
  recordedAt?: number;
}): { inserted: boolean; eventId: string } | null {
  let key: string;
  try { key = scopeKey(input.scope); } catch { return null; }
  const processId = boundedText(input.processId, 160);
  const wakeEventId = boundedText(input.wakeEventId, 240);
  if (!processId || !wakeEventId || !['completed', 'failed', 'waiting'].includes(input.status)) return null;
  const found = getCognitiveEvent(wakeEventId);
  const wakeEvent = found?.type === 'cognitive_process_wake' && found.correlationId === `process:${processId}` ? found : null;
  const wakeValue = wakeEvent ? parseProcessWake(wakeEvent) : null;
  if (!wakeValue || scopeKey(wakeValue.scope) !== key || wakeValue.processId !== processId) return null;
  const recordedAt = boundedPositive(input.recordedAt, nowSec(), 4_102_444_800);
  const value: ProcessCheckpoint = {
    schema: 'cognitive_process_checkpoint.v1', processId, wakeEventId, scope: input.scope,
    status: input.status, recordedAt, outcomeEventIds: uniqueIds(input.outcomeEventIds),
    ...(input.nextWakeAt !== undefined && Number.isSafeInteger(input.nextWakeAt) && input.nextWakeAt > recordedAt
      ? { nextWakeAt: Math.min(4_102_444_800, input.nextWakeAt) } : {}),
  };
  const result = appendCognitiveEvent({
    type: 'cognitive_process_checkpoint', source: 'host', scope: input.scope, occurredAt: recordedAt,
    correlationId: `process:${processId}`, causationId: wakeEventId,
    dedupeKey: `process-checkpoint:${key}:${wakeEventId}:${input.status}`,
    fact: { schema: value.schema, value },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

export function stopProcess(input: { processId: string; scope: CognitiveScope; reason?: string; recordedAt?: number }): { inserted: boolean; eventId: string } | null {
  let key: string;
  try { key = scopeKey(input.scope); } catch { return null; }
  const processId = boundedText(input.processId, 160);
  if (!processId) return null;
  const recordedAt = boundedPositive(input.recordedAt, nowSec(), 4_102_444_800);
  const reason = boundedText(input.reason, 240) || 'stopped_by_host';
  const result = appendCognitiveEvent({
    type: 'cognitive_process_stopped', source: 'host', scope: input.scope, occurredAt: recordedAt,
    correlationId: `process:${processId}`, dedupeKey: `process-stop:${key}:${processId}:${recordedAt}`,
    fact: { schema: 'cognitive_process_stopped.v1', value: { processId, scope: input.scope, reason, recordedAt } },
  });
  return result ? { inserted: result.inserted, eventId: result.event.id } : null;
}

/** Read-only scheduler hook used by the heartbeat. It only emits durable wake records. */
export function runCognitiveContinuityTick(now = nowSec()): { missionsWoken: number; processesWoken: number } {
  const missions = claimDueMissionWakes(now, 20);
  let processesWoken = 0;
  for (const mission of missions) {
    const process = requestProcessWake({
      processId: `mission:${mission.missionId}`,
      kind: 'strategist',
      scope: mission.scope,
      wakeAt: mission.wakeAt,
      reason: mission.reason,
      causeEventIds: [mission.wakeEventId],
    });
    if (process?.inserted) processesWoken += 1;
  }
  return { missionsWoken: missions.length, processesWoken };
}

export function listProcessCheckpointsForTest(): Map<string, ProcessCheckpoint> {
  return processCheckpoints();
}
