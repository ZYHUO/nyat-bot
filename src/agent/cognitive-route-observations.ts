// Durable, metadata-only window for complexity-routing evaluation.
// This module reports route cost and host-observed outcomes; it never changes
// routing behavior or grants permission to call a deeper executor.

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import type { CognitiveRoute } from './cognitive-routing.js';

export type CognitiveRouteObservationStatus =
  | 'classified'
  | 'sent'
  | 'silent'
  | 'failed'
  | 'interrupted'
  | 'blocked';

export interface CognitiveRouteObservationInput {
  chatId: number;
  triggerMessageId: number;
  route: CognitiveRoute;
  score: number;
  primarySignal?: string | null;
  behaviorApplied?: boolean;
  createdAt?: number;
}

export interface CognitiveRouteCompletionInput {
  id: number;
  status: Exclude<CognitiveRouteObservationStatus, 'classified'>;
  latencyMs?: number;
  toolCalls?: number;
  replyCount?: number;
  completedAt?: number;
}

export interface CognitiveRouteWindowRow {
  chatId: number;
  route: CognitiveRoute;
  samples: number;
  behaviorApplied: number;
  completed: number;
  classified: number;
  sent: number;
  silent: number;
  failed: number;
  interrupted: number;
  blocked: number;
  meanLatencyMs: number | null;
  meanToolCalls: number | null;
  meanReplyCount: number | null;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackRate: number | null;
  positiveFeedbackRate: number | null;
}

const MAX_SIGNAL = 80;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function validChatId(value: number): boolean {
  return Number.isSafeInteger(value) && value !== 0;
}

function validMessageId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedNonNegative(value: number | undefined, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

function hasTable(): boolean {
  try {
    return Boolean(getDb().prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cognitive_route_observations'",
    ).get());
  } catch {
    return false;
  }
}

function safeSignal(value: string | null | undefined): string | null {
  const signal = typeof value === 'string' ? value.trim().slice(0, MAX_SIGNAL) : '';
  return signal || null;
}

/** Record one decision idempotently by chat + trigger message. */
export function recordCognitiveRouteDecision(input: CognitiveRouteObservationInput): number | undefined {
  if (!validChatId(input.chatId) || !validMessageId(input.triggerMessageId)) return undefined;
  if (!['fast', 'deep', 'background'].includes(input.route)) return undefined;
  if (!Number.isFinite(input.score)) return undefined;
  try {
    const db = getDb();
    if (!hasTable()) return undefined;
    const score = Math.min(100, Math.max(0, Math.trunc(input.score)));
    const createdAt = Number.isSafeInteger(input.createdAt) && (input.createdAt ?? 0) > 0
      ? Math.trunc(input.createdAt!)
      : nowSec();
    db.prepare(
      `INSERT OR IGNORE INTO cognitive_route_observations
       (chat_id, trigger_message_id, route, score, primary_signal, behavior_applied, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'classified', ?)`,
    ).run(
      input.chatId,
      input.triggerMessageId,
      input.route,
      score,
      safeSignal(input.primarySignal),
      input.behaviorApplied === true ? 1 : 0,
      createdAt,
    );
    const row = db.prepare(
      'SELECT id FROM cognitive_route_observations WHERE chat_id = ? AND trigger_message_id = ?',
    ).get(input.chatId, input.triggerMessageId) as { id?: number } | undefined;
    return typeof row?.id === 'number' ? row.id : undefined;
  } catch (err) {
    logger.debug({ err, chatId: input.chatId, triggerMessageId: input.triggerMessageId }, 'route observation record failed');
    return undefined;
  }
}

/** Complete the first terminal observation; retries cannot overwrite it. */
export function completeCognitiveRouteObservation(input: CognitiveRouteCompletionInput): boolean {
  if (!Number.isSafeInteger(input.id) || input.id <= 0) return false;
  if (!['sent', 'silent', 'failed', 'interrupted', 'blocked'].includes(input.status)) return false;
  try {
    const db = getDb();
    if (!hasTable()) return false;
    const latencyMs = boundedNonNegative(input.latencyMs, 24 * 60 * 60 * 1000);
    const toolCalls = boundedNonNegative(input.toolCalls, 100_000);
    const replyCount = boundedNonNegative(input.replyCount, 1000);
    const completedAt = Number.isSafeInteger(input.completedAt) && (input.completedAt ?? 0) > 0
      ? Math.trunc(input.completedAt!)
      : nowSec();
    const result = db.prepare(
      `UPDATE cognitive_route_observations
       SET status = ?, latency_ms = COALESCE(?, latency_ms),
           tool_calls = COALESCE(?, tool_calls), reply_count = COALESCE(?, reply_count),
           completed_at = ?
       WHERE id = ? AND status = 'classified' AND completed_at IS NULL`,
    ).run(input.status, latencyMs ?? null, toolCalls ?? null, replyCount ?? null, completedAt, input.id);
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, id: input.id }, 'route observation completion failed');
    return false;
  }
}

/** Attach an explicit host-observed positive/negative reply outcome. */
export function recordCognitiveRouteFeedback(input: {
  id: number;
  outcome: 'positive' | 'negative';
  signal?: string | null;
}): boolean {
  if (!Number.isSafeInteger(input.id) || input.id <= 0) return false;
  try {
    const db = getDb();
    if (!hasTable()) return false;
    const result = db.prepare(
      `UPDATE cognitive_route_observations
       SET feedback_outcome = ?, feedback_signal = COALESCE(?, feedback_signal)
       WHERE id = ? AND feedback_outcome IS NULL`,
    ).run(input.outcome, safeSignal(input.signal), input.id);
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, id: input.id }, 'route observation feedback failed');
    return false;
  }
}

/** Attach feedback using the original trigger message as the stable join key. */
export function recordCognitiveRouteFeedbackForTrigger(input: {
  chatId: number;
  triggerMessageId: number;
  outcome: 'positive' | 'negative';
  signal?: string | null;
}): boolean {
  if (!validChatId(input.chatId) || !validMessageId(input.triggerMessageId)) return false;
  try {
    const db = getDb();
    if (!hasTable()) return false;
    const result = db.prepare(
      `UPDATE cognitive_route_observations
       SET feedback_outcome = ?, feedback_signal = COALESCE(?, feedback_signal)
       WHERE chat_id = ? AND trigger_message_id = ? AND feedback_outcome IS NULL`,
    ).run(input.outcome, safeSignal(input.signal), input.chatId, input.triggerMessageId);
    return result.changes === 1;
  } catch (err) {
    logger.debug({ err, chatId: input.chatId, triggerMessageId: input.triggerMessageId }, 'route trigger feedback failed');
    return false;
  }
}

/** Read a bounded route window. `since` is an epoch-second lower bound. */
export function getCognitiveRouteWindow(input: {
  chatId?: number;
  since?: number;
  limit?: number;
} = {}): CognitiveRouteWindowRow[] {
  if (input.chatId !== undefined && !validChatId(input.chatId)) return [];
  try {
    const db = getDb();
    if (!hasTable()) return [];
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.chatId !== undefined) { clauses.push('chat_id = ?'); params.push(input.chatId); }
    if (Number.isSafeInteger(input.since) && (input.since ?? 0) > 0) { clauses.push('created_at >= ?'); params.push(input.since); }
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT chat_id, route,
          COUNT(*) AS samples,
          SUM(behavior_applied) AS behavior_applied,
          SUM(status = 'classified') AS classified,
          SUM(status <> 'classified') AS completed,
          SUM(status = 'sent') AS sent,
          SUM(status = 'silent') AS silent,
          SUM(status = 'failed') AS failed,
          SUM(status = 'interrupted') AS interrupted,
          SUM(status = 'blocked') AS blocked,
          AVG(latency_ms) AS mean_latency_ms,
          AVG(tool_calls) AS mean_tool_calls,
          AVG(reply_count) AS mean_reply_count,
          SUM(feedback_outcome = 'positive') AS feedback_positive,
          SUM(feedback_outcome = 'negative') AS feedback_negative
       FROM cognitive_route_observations ${where}
       GROUP BY chat_id, route
       ORDER BY samples DESC, chat_id ASC, route ASC
       LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const samples = Number(row['samples']) || 0;
      const completed = Number(row['completed']) || 0;
      const feedbackPositive = Number(row['feedback_positive']) || 0;
      const feedbackNegative = Number(row['feedback_negative']) || 0;
      const feedbackTotal = feedbackPositive + feedbackNegative;
      return {
        chatId: Number(row['chat_id']),
        route: row['route'] as CognitiveRoute,
        samples,
        behaviorApplied: Number(row['behavior_applied']) || 0,
        completed,
        classified: Number(row['classified']) || 0,
        sent: Number(row['sent']) || 0,
        silent: Number(row['silent']) || 0,
        failed: Number(row['failed']) || 0,
        interrupted: Number(row['interrupted']) || 0,
        blocked: Number(row['blocked']) || 0,
        meanLatencyMs: row['mean_latency_ms'] === null ? null : Number(row['mean_latency_ms']),
        meanToolCalls: row['mean_tool_calls'] === null ? null : Number(row['mean_tool_calls']),
        meanReplyCount: row['mean_reply_count'] === null ? null : Number(row['mean_reply_count']),
        feedbackPositive,
        feedbackNegative,
        feedbackRate: samples > 0 ? feedbackTotal / samples : null,
        positiveFeedbackRate: feedbackTotal > 0 ? feedbackPositive / feedbackTotal : null,
      };
    });
  } catch (err) {
    logger.debug({ err }, 'route observation window read failed');
    return [];
  }
}
