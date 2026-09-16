// Replayable, metadata-only social interaction graph.
//
// `social_edges` remains the compact legacy prompt hint. This module keeps the
// underlying interaction facts in cognitive_events so evaluation and future
// social-model projections can answer who interacted, when, and why without
// treating an aggregate edge as an irreversible fact.

import { appendCognitiveEvent, getCognitiveEvent, listCognitiveEvents } from './cognitive-events.js';
import type { CognitiveEvent, CognitiveEventSource } from './cognitive-events.js';
import { resolveSocialPredictionsForInteraction } from './social-predictions.js';

export type SocialInteractionKind = 'reply' | 'mention' | 'reaction' | 'support' | 'conflict' | 'repair';
export type SocialInteractionSource = Extract<CognitiveEventSource, 'telegram' | 'host'>;

export interface SocialInteractionInput {
  chatId: number;
  fromUid: number;
  toUid: number;
  kind: SocialInteractionKind;
  messageId?: number;
  occurredAt?: number;
  source?: SocialInteractionSource;
  correlationId?: string;
  dedupeKey?: string;
}

export interface SocialInteractionRecord {
  eventId: string;
  chatId: number;
  fromUid: number;
  toUid: number;
  kind: SocialInteractionKind;
  messageId: number | null;
  occurredAt: number;
  correlationId: string;
  source: SocialInteractionSource;
}

export interface SocialGraphEdge {
  fromUid: number;
  toUid: number;
  interactionCount: number;
  weight: number;
  lastAt: number;
  kinds: SocialInteractionKind[];
}

export interface SocialGraphSnapshot {
  chatId: number;
  asOfEventId?: string;
  interactionCount: number;
  edges: SocialGraphEdge[];
}

export interface SocialRepairEvaluation {
  chatId: number;
  actorUid: number;
  targetUid: number;
  conflictEventId: string;
  conflictAt: number;
  repairEventId: string;
  repairAt: number;
  followupEventId: string | null;
  followupKind: SocialInteractionKind | null;
  repaired: boolean;
  repairLatencySec: number;
}

const KINDS: ReadonlySet<string> = new Set(['reply', 'mention', 'reaction', 'support', 'conflict', 'repair']);
const KIND_WEIGHT: Record<SocialInteractionKind, number> = {
  reply: 1,
  mention: 0.8,
  reaction: 0.5,
  support: 1.1,
  conflict: 1,
  repair: 1.2,
};
const HALF_LIFE_SEC = 14 * 24 * 3600;

function validUid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(1, candidate));
}

function validOccurredAt(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseMessageId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseSocialEvent(event: CognitiveEvent, chatId: number): SocialInteractionRecord | null {
  if (event.type !== 'social_interaction' || event.chatId !== chatId) return null;
  const fact = event.fact;
  const fromUid = typeof fact['fromUid'] === 'number' ? fact['fromUid'] : NaN;
  const toUid = typeof fact['toUid'] === 'number' ? fact['toUid'] : NaN;
  const kind = fact['kind'];
  if (!validUid(fromUid) || !validUid(toUid) || fromUid === toUid) return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (event.source !== 'telegram' && event.source !== 'host') return null;
  return {
    eventId: event.id,
    chatId,
    fromUid,
    toUid,
    kind: kind as SocialInteractionKind,
    messageId: parseMessageId(fact['messageId']),
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    source: event.source,
  };
}

/** Append one interaction fact. Invalid or unavailable event stores are no-ops. */
export function recordSocialInteraction(input: SocialInteractionInput): { inserted: boolean; eventId: string } | null {
  if (!validChatId(input.chatId) || !validUid(input.fromUid) || !validUid(input.toUid) || input.fromUid === input.toUid) return null;
  if (!KINDS.has(input.kind)) return null;
  const occurredAt = validOccurredAt(input.occurredAt);
  if (input.occurredAt !== undefined && occurredAt === undefined) return null;
  const messageId = parseMessageId(input.messageId);
  if (input.messageId !== undefined && messageId === null) return null;
  const correlationId = input.correlationId?.trim().slice(0, 240)
    || `social:${input.chatId}:${messageId ?? `${input.fromUid}:${input.toUid}`}`;
  const dedupeKey = input.dedupeKey?.trim().slice(0, 240)
    || `social:${input.chatId}:${messageId ?? occurredAt ?? 'event'}:${input.fromUid}:${input.toUid}:${input.kind}`;
  const appended = appendCognitiveEvent({
    type: 'social_interaction',
    source: input.source ?? 'telegram',
    scope: { visibility: 'chat', chatId: input.chatId },
    ...(occurredAt === undefined ? {} : { occurredAt }),
    correlationId,
    dedupeKey,
    fact: {
      fromUid: input.fromUid,
      toUid: input.toUid,
      kind: input.kind,
      messageId,
    },
  });
  if (!appended) return null;
  // A social interaction is also the host-observed outcome for any pending
  // expectation attached to this bot message. Resolution is bounded and
  // best-effort; the interaction event remains authoritative.
  if (messageId !== null) {
    try {
      resolveSocialPredictionsForInteraction({
        chatId: input.chatId,
        botMessageId: messageId,
        actorUserId: input.fromUid,
        kind: input.kind,
        eventId: appended.event.id,
        ...(occurredAt === undefined ? {} : { occurredAt }),
      });
    } catch {
      /* prediction telemetry never blocks social event recording */
    }
  }
  return { inserted: appended.inserted, eventId: appended.event.id };
}

function validAnchor(anchor: CognitiveEvent | null, chatId: number): boolean {
  return !!anchor
    && anchor.chatId === chatId
    && anchor.visibility === 'chat'
    && anchor.scopeKey === `chat:${chatId}`;
}

/** List interaction facts in newest-first occurred-at order within one chat. */
export function listSocialInteractions(options: {
  chatId: number;
  userId?: number;
  asOfEventId?: string;
  limit?: number;
}): SocialInteractionRecord[] {
  if (!validChatId(options.chatId)) return [];
  if (options.userId !== undefined && !validUid(options.userId)) return [];
  const limit = boundedLimit(options.limit, 500, 2000);
  const anchor = options.asOfEventId ? getCognitiveEvent(options.asOfEventId) : null;
  if (options.asOfEventId && !validAnchor(anchor, options.chatId)) return [];
  const events = listCognitiveEvents({
    scope: { visibility: 'chat', chatId: options.chatId },
    type: 'social_interaction',
    order: 'occurred_at_desc',
    // Read a bounded superset, then apply the as-of/user filters before the
    // graph-specific limit. The social time index backs this query.
    limit: Math.min(1000, Math.max(limit * 4, limit)),
  });
  return events
    .map((event) => parseSocialEvent(event, options.chatId))
    .filter((event): event is SocialInteractionRecord => !!event)
    .filter((event) => !anchor || event.occurredAt <= anchor.occurredAt)
    .filter((event) => options.userId === undefined || event.fromUid === options.userId || event.toUid === options.userId)
    .sort((a, b) => b.occurredAt - a.occurredAt || b.eventId.localeCompare(a.eventId))
    .slice(0, limit);
}

/** Build a bounded, directed and time-decayed graph for one chat scope. */
export function buildSocialGraph(options: {
  chatId: number;
  userId?: number;
  asOfEventId?: string;
  limit?: number;
  maxEdges?: number;
  nowSec?: number;
}): SocialGraphSnapshot {
  const interactions = listSocialInteractions(options);
  const anchor = options.asOfEventId ? getCognitiveEvent(options.asOfEventId) : null;
  const referenceAt = anchor && validAnchor(anchor, options.chatId)
    ? anchor.occurredAt
    : (Number.isSafeInteger(options.nowSec) && (options.nowSec ?? 0) > 0 ? options.nowSec! : Math.floor(Date.now() / 1000));
  const grouped = new Map<string, SocialGraphEdge>();
  for (const interaction of interactions) {
    const key = `${interaction.fromUid}:${interaction.toUid}`;
    const age = Math.max(0, referenceAt - interaction.occurredAt);
    const decay = Math.pow(0.5, age / HALF_LIFE_SEC);
    const current = grouped.get(key) ?? {
      fromUid: interaction.fromUid,
      toUid: interaction.toUid,
      interactionCount: 0,
      weight: 0,
      lastAt: interaction.occurredAt,
      kinds: [],
    };
    current.interactionCount += 1;
    current.weight += KIND_WEIGHT[interaction.kind] * decay;
    current.lastAt = Math.max(current.lastAt, interaction.occurredAt);
    if (!current.kinds.includes(interaction.kind)) current.kinds.push(interaction.kind);
    grouped.set(key, current);
  }
  const maxEdges = boundedLimit(options.maxEdges, 100, 500);
  const edges = [...grouped.values()]
    .sort((a, b) => b.weight - a.weight || b.lastAt - a.lastAt || a.fromUid - b.fromUid || a.toUid - b.toUid)
    .slice(0, maxEdges)
    .map((edge) => ({ ...edge, weight: Number(edge.weight.toFixed(6)), kinds: [...edge.kinds].sort() }));
  return {
    chatId: options.chatId,
    ...(options.asOfEventId ? { asOfEventId: options.asOfEventId } : {}),
    interactionCount: interactions.length,
    edges,
  };
}

/**
 * Evaluate a bounded conflict -> repair sequence without changing relationship
 * state. A repair counts as successful when a later reply/support/mention from
 * the same actor to the same target arrives within the observation window.
 */
export function evaluateSocialRepairs(options: {
  chatId: number;
  asOfEventId?: string;
  limit?: number;
  windowSec?: number;
}): SocialRepairEvaluation[] {
  if (!validChatId(options.chatId)) return [];
  const limit = boundedLimit(options.limit, 100, 500);
  const windowSec = typeof options.windowSec === 'number' && Number.isFinite(options.windowSec)
    ? Math.min(7 * 24 * 3600, Math.max(60, Math.trunc(options.windowSec)))
    : 7 * 24 * 3600;
  const interactions = listSocialInteractions({
    chatId: options.chatId,
    ...(options.asOfEventId ? { asOfEventId: options.asOfEventId } : {}),
    limit: Math.min(2000, Math.max(limit * 8, 200)),
  }).sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
  const repairs: SocialRepairEvaluation[] = [];
  const usedConflicts = new Set<string>();
  for (const repair of interactions) {
    if (repair.kind !== 'repair') continue;
    const conflict = [...interactions]
      .reverse()
      .find((candidate) =>
        candidate.kind === 'conflict'
        && candidate.fromUid === repair.fromUid
        && candidate.toUid === repair.toUid
        && candidate.occurredAt <= repair.occurredAt
        && repair.occurredAt - candidate.occurredAt <= windowSec
        && !usedConflicts.has(candidate.eventId),
      );
    if (!conflict) continue;
    usedConflicts.add(conflict.eventId);
    const followup = interactions.find((candidate) =>
      candidate.fromUid === repair.fromUid
      && candidate.toUid === repair.toUid
      && candidate.occurredAt > repair.occurredAt
      && candidate.occurredAt - repair.occurredAt <= windowSec
      && (candidate.kind === 'reply' || candidate.kind === 'mention' || candidate.kind === 'support'),
    );
    repairs.push({
      chatId: options.chatId,
      actorUid: repair.fromUid,
      targetUid: repair.toUid,
      conflictEventId: conflict.eventId,
      conflictAt: conflict.occurredAt,
      repairEventId: repair.eventId,
      repairAt: repair.occurredAt,
      followupEventId: followup?.eventId ?? null,
      followupKind: followup?.kind ?? null,
      repaired: !!followup,
      repairLatencySec: repair.occurredAt - conflict.occurredAt,
    });
    if (repairs.length >= limit) break;
  }
  return repairs.sort((a, b) => b.repairAt - a.repairAt || b.repairEventId.localeCompare(a.repairEventId));
}

export function summarizeSocialRepairs(options: {
  chatId: number;
  asOfEventId?: string;
  limit?: number;
  windowSec?: number;
}): { samples: number; repaired: number; repairRate: number; meanLatencySec: number } {
  const rows = evaluateSocialRepairs(options);
  if (!rows.length) return { samples: 0, repaired: 0, repairRate: 0, meanLatencySec: 0 };
  return {
    samples: rows.length,
    repaired: rows.filter((row) => row.repaired).length,
    repairRate: rows.filter((row) => row.repaired).length / rows.length,
    meanLatencySec: rows.reduce((sum, row) => sum + row.repairLatencySec, 0) / rows.length,
  };
}
