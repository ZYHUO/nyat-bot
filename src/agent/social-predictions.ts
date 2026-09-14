// Bounded, metadata-only social prediction ledger.
//
// Predictions describe an expected interaction after a bot delivery. Only
// host-observable social events can settle them; expiry records silence rather
// than treating an absent event as model-confirmed success.

import { appendCognitiveEvent } from './cognitive-events.js';
import type { SocialInteractionKind } from './social-event-graph.js';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export type SocialPredictionKind = 'engagement' | 'support' | 'conflict' | 'repair' | 'silence';

export interface SocialPredictionInput {
  chatId: number;
  targetUserId?: number;
  botMessageId: number;
  triggerMessageId?: number;
  expectedKind: SocialPredictionKind;
  expectedProbability: number;
  actionType?: string;
  sourceEventId?: string;
  observationWindowSec?: number;
}

export interface SocialPredictionRecord {
  id: number;
  chatId: number;
  targetUserId: number | null;
  botMessageId: number;
  triggerMessageId: number | null;
  expectedKind: SocialPredictionKind;
  expectedProbability: number;
  actionType: string | null;
  sourceEventId: string | null;
  observedKind: SocialInteractionKind | 'silence' | null;
  observedScore: number | null;
  predictionError: number | null;
  outcomeEventId: string | null;
  resolvedAt: number | null;
  observationWindowSec: number;
  createdAt: number;
}

export interface SocialPredictionCalibration {
  samples: number;
  meanError: number;
  meanAbsoluteError: number;
  accuracy: number;
}

const EXPECTED_KINDS: ReadonlySet<string> = new Set(['engagement', 'support', 'conflict', 'repair', 'silence']);
const OBSERVATION_WINDOW_SEC = 24 * 3600;
const MIN_OBSERVATION_WINDOW_SEC = 60;
const MAX_OBSERVATION_WINDOW_SEC = 7 * 24 * 3600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasTable(db: ReturnType<typeof getDb>): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'social_predictions'").get());
  } catch {
    return false;
  }
}

function validChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value < 0;
}

function validUid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validMessageId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedProbability(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function boundedActionType(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().slice(0, 64);
  return normalized && /^[a-z][a-z0-9_.:-]*$/.test(normalized) ? normalized : null;
}

function boundedWindow(value: number | undefined): number {
  const candidate = value === undefined || !Number.isFinite(value)
    ? OBSERVATION_WINDOW_SEC
    : Math.trunc(value);
  return Math.min(MAX_OBSERVATION_WINDOW_SEC, Math.max(MIN_OBSERVATION_WINDOW_SEC, candidate));
}

function rowToPrediction(row: Record<string, unknown>): SocialPredictionRecord {
  return {
    id: Number(row.id),
    chatId: Number(row.chat_id),
    targetUserId: row.target_user_id === null ? null : Number(row.target_user_id),
    botMessageId: Number(row.bot_message_id),
    triggerMessageId: row.trigger_message_id === null ? null : Number(row.trigger_message_id),
    expectedKind: row.expected_kind as SocialPredictionKind,
    expectedProbability: Number(row.expected_probability),
    actionType: row.action_type === null ? null : String(row.action_type),
    sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
    observedKind: row.observed_kind === null ? null : row.observed_kind as SocialInteractionKind | 'silence',
    observedScore: row.observed_score === null ? null : Number(row.observed_score),
    predictionError: row.prediction_error === null ? null : Number(row.prediction_error),
    outcomeEventId: row.outcome_event_id === null ? null : String(row.outcome_event_id),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    observationWindowSec: Number(row.observation_window_sec),
    createdAt: Number(row.created_at),
  };
}

function appendPredictionEvent(input: {
  chatId: number;
  botMessageId: number;
  expectedKind: SocialPredictionKind;
  expectedProbability: number;
  targetUserId: number | null;
  triggerMessageId: number | null;
  actionType: string | null;
  sourceEventId?: string;
}): string | undefined {
  try {
    const result = appendCognitiveEvent({
      type: 'social_prediction',
      source: 'host',
      scope: { visibility: 'chat', chatId: input.chatId },
      ...(input.sourceEventId ? { causationId: input.sourceEventId } : {}),
      correlationId: `social:${input.chatId}:prediction:${input.botMessageId}`,
      dedupeKey: `social-prediction:${input.chatId}:${input.botMessageId}:${input.expectedKind}`,
      fact: {
        chatId: input.chatId,
        botMessageId: input.botMessageId,
        targetUserId: input.targetUserId,
        triggerMessageId: input.triggerMessageId,
        expectedKind: input.expectedKind,
        expectedProbability: input.expectedProbability,
        actionType: input.actionType,
      },
    });
    return result?.event.id;
  } catch {
    return undefined;
  }
}

/** Record one expected social outcome. Invalid or unavailable stores are no-ops. */
export function recordSocialPrediction(input: SocialPredictionInput): { inserted: boolean; id: number; eventId?: string } | null {
  if (!validChatId(input.chatId) || !validMessageId(input.botMessageId)) return null;
  if (input.targetUserId !== undefined && !validUid(input.targetUserId)) return null;
  if (input.triggerMessageId !== undefined && !validMessageId(input.triggerMessageId)) return null;
  if (!EXPECTED_KINDS.has(input.expectedKind)) return null;
  const probability = boundedProbability(input.expectedProbability);
  if (probability === null) return null;
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return null;
  }
  if (!hasTable(db)) return null;
  const targetUserId = input.targetUserId ?? null;
  const triggerMessageId = input.triggerMessageId ?? null;
  const actionType = boundedActionType(input.actionType);
  const sourceEventId = input.sourceEventId?.trim().slice(0, 240) || null;
  const observationWindowSec = boundedWindow(input.observationWindowSec);
  const eventId = appendPredictionEvent({
    chatId: input.chatId,
    botMessageId: input.botMessageId,
    expectedKind: input.expectedKind,
    expectedProbability: probability,
    targetUserId,
    triggerMessageId,
    actionType,
    ...(sourceEventId ? { sourceEventId } : {}),
  });
  try {
    const result = db.prepare(
      `INSERT OR IGNORE INTO social_predictions
         (chat_id, target_user_id, bot_message_id, trigger_message_id, expected_kind,
          expected_probability, action_type, source_event_id, observation_window_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.chatId,
      targetUserId,
      input.botMessageId,
      triggerMessageId,
      input.expectedKind,
      probability,
      actionType,
      sourceEventId ?? eventId ?? null,
      observationWindowSec,
      nowSec(),
    );
    const row = db.prepare(
      `SELECT * FROM social_predictions
        WHERE chat_id = ? AND bot_message_id = ? AND expected_kind = ?`,
    ).get(input.chatId, input.botMessageId, input.expectedKind) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { inserted: result.changes === 1, id: Number(row.id), ...(eventId ? { eventId } : {}) };
  } catch (err) {
    logger.debug({ err, chatId: input.chatId, botMessageId: input.botMessageId }, 'social prediction append failed (non-critical)');
    return null;
  }
}

/** Conservative default for a delivered group message. */
export function socialEngagementProbability(input: {
  chatId: number;
  replyToMessageId?: number;
  actionType?: string;
}): number | null {
  if (!validChatId(input.chatId)) return null;
  if (input.replyToMessageId !== undefined && validMessageId(input.replyToMessageId)) return 0.7;
  const action = boundedActionType(input.actionType);
  if (action === 'clarification') return 0.65;
  if (action === 'final' || action === 'conversation') return 0.5;
  if (action === 'discovery' || action === 'partial_result') return 0.4;
  if (action === 'progress') return 0.3;
  return 0.35;
}

/** Record the standard engagement expectation after a real group delivery. */
export function recordSocialDeliveryPrediction(input: {
  chatId: number;
  botMessageId: number;
  targetUserId?: number;
  triggerMessageId?: number;
  replyToMessageId?: number;
  actionType?: string;
  sourceEventId?: string;
}): { inserted: boolean; id: number; eventId?: string } | null {
  const probability = socialEngagementProbability(input);
  if (probability === null) return null;
  return recordSocialPrediction({
    chatId: input.chatId,
    botMessageId: input.botMessageId,
    expectedKind: 'engagement',
    expectedProbability: probability,
    ...(input.targetUserId === undefined ? {} : { targetUserId: input.targetUserId }),
    ...((input.triggerMessageId ?? input.replyToMessageId) === undefined
      ? {}
      : { triggerMessageId: input.triggerMessageId ?? input.replyToMessageId }),
    ...(input.actionType === undefined ? {} : { actionType: input.actionType }),
    ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
  });
}

function observedPredictionKind(kind: SocialInteractionKind): SocialPredictionKind {
  if (kind === 'reply' || kind === 'mention' || kind === 'reaction' || kind === 'support' || kind === 'conflict' || kind === 'repair') {
    return kind === 'reply' || kind === 'mention' || kind === 'reaction' ? 'engagement' : kind;
  }
  return 'engagement';
}

function satisfiesExpected(expected: SocialPredictionKind, observed: SocialPredictionKind): boolean {
  return expected === 'engagement'
    ? observed !== 'silence'
    : expected === observed;
}

function settlePrediction(input: {
  row: SocialPredictionRecord;
  observedKind: SocialInteractionKind | 'silence';
  observedScore: number;
  outcomeEventId?: string;
  resolvedAt: number;
}): boolean {
  const db = getDb();
  const changed = db.prepare(
    `UPDATE social_predictions
        SET observed_kind = ?, observed_score = ?, prediction_error = ?, outcome_event_id = ?, resolved_at = ?
      WHERE id = ? AND resolved_at IS NULL`,
  ).run(
    input.observedKind,
    input.observedScore,
    input.observedScore - input.row.expectedProbability,
    input.outcomeEventId?.trim().slice(0, 240) ?? null,
    input.resolvedAt,
    input.row.id,
  ).changes;
  if (changed !== 1) return false;
  try {
    appendCognitiveEvent({
      type: 'social_prediction',
      source: 'host',
      scope: { visibility: 'chat', chatId: input.row.chatId },
      ...(input.outcomeEventId ? { causationId: input.outcomeEventId } : {}),
      correlationId: `social:${input.row.chatId}:prediction:${input.row.botMessageId}`,
      dedupeKey: `social-prediction-outcome:${input.row.id}`,
      fact: {
        predictionId: input.row.id,
        botMessageId: input.row.botMessageId,
        expectedKind: input.row.expectedKind,
        observedKind: input.observedKind,
        observedScore: input.observedScore,
        predictionError: input.observedScore - input.row.expectedProbability,
        outcomeEventId: input.outcomeEventId ?? null,
        reason: input.observedKind === 'silence' ? 'observation_window_elapsed' : 'interaction_observed',
      },
    });
  } catch {
    /* The SQLite ledger remains authoritative when event telemetry is unavailable. */
  }
  return true;
}

/** Settle pending predictions when a host-observed interaction arrives. */
export function resolveSocialPredictionsForInteraction(input: {
  chatId: number;
  botMessageId: number;
  actorUserId: number;
  kind: SocialInteractionKind;
  eventId?: string;
  occurredAt?: number;
}): number {
  if (!validChatId(input.chatId) || !validMessageId(input.botMessageId) || !validUid(input.actorUserId)) return 0;
  const observed = observedPredictionKind(input.kind);
  const resolvedAt = input.occurredAt !== undefined && Number.isSafeInteger(input.occurredAt) && input.occurredAt > 0
    ? input.occurredAt : nowSec();
  try {
    const db = getDb();
    if (!hasTable(db)) return 0;
    const rows = db.prepare(
      `SELECT * FROM social_predictions
        WHERE chat_id = ? AND bot_message_id = ? AND resolved_at IS NULL
          AND (target_user_id IS NULL OR target_user_id = ?)
        ORDER BY id ASC LIMIT 20`,
    ).all(input.chatId, input.botMessageId, input.actorUserId) as Array<Record<string, unknown>>;
    let settled = 0;
    for (const raw of rows) {
      const row = rowToPrediction(raw);
      const score = satisfiesExpected(row.expectedKind, observed) ? 1 : 0;
      if (settlePrediction({ row, observedKind: input.kind, observedScore: score, ...(input.eventId ? { outcomeEventId: input.eventId } : {}), resolvedAt })) settled += 1;
    }
    return settled;
  } catch (err) {
    logger.debug({ err, chatId: input.chatId, botMessageId: input.botMessageId }, 'social prediction resolution failed (non-critical)');
    return 0;
  }
}

/** Resolve predictions whose observation windows have elapsed. */
export function expireSocialPredictions(options: { chatId?: number; nowSec?: number; limit?: number } = {}): number {
  const referenceAt = options.nowSec !== undefined && Number.isSafeInteger(options.nowSec) && options.nowSec > 0 ? options.nowSec : nowSec();
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 100)));
  try {
    const db = getDb();
    if (!hasTable(db)) return 0;
    const params: unknown[] = [];
    const chatClause = options.chatId === undefined ? '' : ' AND chat_id = ?';
    if (options.chatId !== undefined) {
      if (!validChatId(options.chatId)) return 0;
      params.push(options.chatId);
    }
    const rows = db.prepare(
      `SELECT * FROM social_predictions
        WHERE resolved_at IS NULL${chatClause}
          AND created_at + observation_window_sec <= ?
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(...params, referenceAt, limit) as Array<Record<string, unknown>>;
    let settled = 0;
    for (const raw of rows) {
      const row = rowToPrediction(raw);
      const score = row.expectedKind === 'silence' ? 1 : 0;
      if (settlePrediction({ row, observedKind: 'silence', observedScore: score, resolvedAt: referenceAt })) settled += 1;
    }
    return settled;
  } catch (err) {
    logger.debug({ err }, 'social prediction expiry failed (non-critical)');
    return 0;
  }
}

/** Read a bounded prediction ledger for evaluation and operational reports. */
export function listSocialPredictions(options: {
  chatId: number;
  targetUserId?: number;
  pendingOnly?: boolean;
  limit?: number;
}): SocialPredictionRecord[] {
  if (!validChatId(options.chatId)) return [];
  if (options.targetUserId !== undefined && !validUid(options.targetUserId)) return [];
  const limit = Math.min(500, Math.max(1, Math.trunc(options.limit ?? 100)));
  try {
    const db = getDb();
    if (!hasTable(db)) return [];
    const clauses = ['chat_id = ?'];
    const params: unknown[] = [options.chatId];
    if (options.targetUserId !== undefined) {
      clauses.push('target_user_id = ?');
      params.push(options.targetUserId);
    }
    if (options.pendingOnly) clauses.push('resolved_at IS NULL');
    const rows = db.prepare(
      `SELECT * FROM social_predictions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToPrediction);
  } catch (err) {
    logger.debug({ err, chatId: options.chatId }, 'social prediction list failed (non-critical)');
    return [];
  }
}

/** Aggregate only resolved host outcomes; never mutates strategy or beliefs. */
export function summarizeSocialPredictionCalibration(chatId?: number, limit = 500): SocialPredictionCalibration {
  const rows = chatId === undefined ? (() => {
    try {
      const db = getDb();
      if (!hasTable(db)) return [];
      const bounded = Math.min(5000, Math.max(1, Math.trunc(limit)));
      return (db.prepare('SELECT * FROM social_predictions WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC, id DESC LIMIT ?').all(bounded) as Array<Record<string, unknown>>).map(rowToPrediction);
    } catch {
      return [];
    }
  })() : listSocialPredictions({ chatId, limit }).filter((row) => row.resolvedAt !== null);
  const usable = rows.filter((row) => typeof row.observedScore === 'number' && Number.isFinite(row.observedScore));
  if (!usable.length) return { samples: 0, meanError: 0, meanAbsoluteError: 0, accuracy: 0 };
  const errors = usable.map((row) => row.predictionError ?? 0);
  const correct = usable.filter((row) => {
    const observed = row.observedKind === 'silence'
      ? 'silence'
      : row.observedKind === null
        ? 'silence'
        : observedPredictionKind(row.observedKind);
    return satisfiesExpected(row.expectedKind, observed);
  }).length;
  return {
    samples: usable.length,
    meanError: errors.reduce((sum, value) => sum + value, 0) / usable.length,
    meanAbsoluteError: errors.reduce((sum, value) => sum + Math.abs(value), 0) / usable.length,
    accuracy: correct / usable.length,
  };
}
