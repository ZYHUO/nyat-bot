// ────────────────────────────────────────
// Predictions — 行动后果预测记录 (CSR Phase D)
//
// 记录每次 bot 交付时的预测（sentiment 先验），用户反馈到达后回填
// actual + prediction_error。第一阶段预测来自系统先验（0.5 中性），
// 后续可由模型自报；本模块只存事实，不做智能判断。
// fail-soft：预测从不阻塞发送或反馈主流程。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export type PredictionScale = 'probability' | 'signed' | 'legacy_probability';

export interface PredictionDimensionFilter {
  userId?: number;
  actionType?: string;
}

export interface PredictionCalibrationDimension {
  chatId: number;
  userId: number | null;
  actionType: string | null;
  calibration: PredictionCalibration;
}

export interface PredictionModelRevision {
  id: number;
  chatId: number;
  userId: number | null;
  actionType: string | null;
  sampleCount: number;
  meanError: number;
  previousBias: number;
  newBias: number;
  sourcePredictionId: number;
  outcomeEventId: string | null;
  createdAt: number;
}

const MIN_MODEL_REVISION_SAMPLES = 3;
const MODEL_REVISION_LEARNING_RATE = 0.25;
const MAX_MODEL_BIAS = 0.75;

function hasColumn(db: ReturnType<typeof getDb>, column: string): boolean {
  try {
    return (db.prepare('PRAGMA table_info(bot_predictions)').all() as Array<{ name?: string }>).some((item) => item.name === column);
  } catch {
    return false;
  }
}

function hasTable(db: ReturnType<typeof getDb>, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function boundedActionType(value: string | undefined): string | null {
  const action = value?.trim().toLowerCase().slice(0, 64);
  return action && /^[a-z][a-z0-9_.:-]*$/.test(action) ? action : null;
}

function boundedUserId(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function dimensionWhere(userId: number | null, actionType: string | null): { sql: string; params: unknown[] } {
  return {
    sql: `
      AND ((user_id = ?) OR (user_id IS NULL AND ? IS NULL))
      AND ((action_type = ?) OR (action_type IS NULL AND ? IS NULL))`,
    params: [userId, userId, actionType, actionType],
  };
}

/**
 * Append a bounded calibration revision after enough host-observed outcomes.
 * This is deliberately a ledger only: no prompt, skill or policy is mutated
 * here, and one prediction can produce at most one revision.
 */
function appendPredictionModelRevision(input: {
  db: ReturnType<typeof getDb>;
  predictionId: number;
  chatId: number;
  userId: number | null;
  actionType: string | null;
  outcomeEventId?: string;
}): void {
  const { db } = input;
  if (!hasTable(db, 'prediction_model_revisions') || !hasColumn(db, 'user_id') || !hasColumn(db, 'action_type')) return;
  try {
    const where = dimensionWhere(input.userId, input.actionType);
    const aggregate = db.prepare(
      `SELECT COUNT(*) AS samples, AVG(prediction_error) AS mean_error
         FROM bot_predictions
        WHERE chat_id = ? AND resolved_at IS NOT NULL AND prediction_error IS NOT NULL${where.sql}`,
    ).get(input.chatId, ...where.params) as { samples?: number; mean_error?: number | null } | undefined;
    const samples = Number(aggregate?.samples ?? 0);
    const meanError = Number(aggregate?.mean_error);
    if (!Number.isSafeInteger(samples) || samples < MIN_MODEL_REVISION_SAMPLES || !Number.isFinite(meanError)) return;

    const previous = db.prepare(
      `SELECT new_bias
         FROM prediction_model_revisions
        WHERE chat_id = ?${where.sql}
        ORDER BY id DESC LIMIT 1`,
    ).get(input.chatId, ...where.params) as { new_bias?: number } | undefined;
    const previousBias = Number.isFinite(previous?.new_bias) ? Number(previous!.new_bias) : 0;
    const newBias = Math.min(
      MAX_MODEL_BIAS,
      Math.max(-MAX_MODEL_BIAS, previousBias + MODEL_REVISION_LEARNING_RATE * (meanError - previousBias)),
    );
    db.prepare(
      `INSERT OR IGNORE INTO prediction_model_revisions
         (chat_id, user_id, action_type, sample_count, mean_error, previous_bias, new_bias,
          source_prediction_id, outcome_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.chatId,
      input.userId,
      input.actionType,
      samples,
      Math.min(2, Math.max(-2, meanError)),
      previousBias,
      newBias,
      input.predictionId,
      input.outcomeEventId?.trim().slice(0, 240) || null,
      nowSec(),
    );
  } catch (err) {
    logger.debug({ err, chatId: input.chatId, predictionId: input.predictionId }, 'prediction model revision append failed (non-critical)');
  }
}

/** bot 交付消息时登记预测。message_id 用于后续反馈归因。 */
export function recordPrediction(input: {
  chatId: number;
  taskId?: string;
  messageId?: number;
  source?: 'system_prior' | 'model';
  prediction?: string;
  predictedSentiment?: number;
  /** `runtime.predict` uses probability semantics; signed is available to host adapters. */
  predictionScale?: Exclude<PredictionScale, 'legacy_probability'>;
  sourceEventId?: string;
  /** Optional grouping dimensions for calibration reports. */
  userId?: number;
  actionType?: string;
}): void {
  try {
    const db = getDb();
    const source = input.source ?? 'system_prior';
    const scale = input.predictionScale ?? 'probability';
    const raw = scale === 'signed'
      ? clamp(input.predictedSentiment ?? 0, -1, 1)
      : clamp(input.predictedSentiment ?? 0.5, 0, 1);
    const signed = scale === 'signed' ? raw : (2 * raw) - 1;
    const sourceEventId = input.sourceEventId?.trim().slice(0, 240) || null;
    const columns = ['chat_id', 'task_id', 'message_id', 'source', 'prediction', 'predicted_sentiment', 'created_at'];
    const values: unknown[] = [
      input.chatId,
      input.taskId ?? null,
      input.messageId ?? null,
      source,
      input.prediction?.slice(0, 400) ?? null,
      hasColumn(db, 'prediction_scale') ? raw : clamp(input.predictedSentiment ?? 0.5, 0, 1),
      nowSec(),
    ];
    if (hasColumn(db, 'scope_key')) {
      columns.push('scope_key', 'visibility');
      values.push(`chat:${input.chatId}`, 'chat');
    }
    if (hasColumn(db, 'source_event_id')) {
      columns.push('source_event_id');
      values.push(sourceEventId);
    }
    if (hasColumn(db, 'prediction_scale')) {
      columns.push('prediction_scale', 'predicted_signed');
      values.push(scale, signed);
    }
    if (hasColumn(db, 'user_id')) {
      columns.push('user_id');
      values.push(boundedUserId(input.userId));
    }
    if (hasColumn(db, 'action_type')) {
      columns.push('action_type');
      values.push(boundedActionType(input.actionType));
    }
    db.prepare(
      `INSERT INTO bot_predictions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...values);
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'recordPrediction failed (non-critical)');
  }
}

/**
 * 用户反馈到达后回填 actual 并计算 error。
 * sentiment ∈ [-1, +1]，先验为 0.5（偏正中性），error = actual - predicted。
 * 只对未 resolved 的预测生效；同消息多条反馈只回填第一条（首个反应最接近即时反应）。
 */
export function resolvePrediction(input: {
  chatId: number;
  messageId: number;
  actualSentiment: number;
  feedbackKind: string;
  outcomeEventId?: string;
}): void {
  const actual = Math.min(1, Math.max(-1, input.actualSentiment));
  try {
    const db = getDb();
    const signedColumn = hasColumn(db, 'predicted_signed');
    const dimensions = hasColumn(db, 'user_id') && hasColumn(db, 'action_type');
    const row = db
      .prepare(
        `SELECT id, predicted_sentiment${signedColumn ? ', predicted_signed' : ''}${dimensions ? ', user_id, action_type' : ''} FROM bot_predictions
         WHERE chat_id = ? AND message_id = ? AND resolved_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(input.chatId, input.messageId) as {
        id: number;
        predicted_sentiment: number;
        predicted_signed?: number | null;
        user_id?: number | null;
        action_type?: string | null;
      } | undefined;
    if (!row) return;
    const predicted = signedColumn && row.predicted_signed !== null && row.predicted_signed !== undefined
      ? row.predicted_signed
      : row.predicted_sentiment;
    const error = actual - predicted;
    if (hasColumn(db, 'outcome_event_id')) {
      db.prepare(
        `UPDATE bot_predictions
         SET actual_sentiment = ?, prediction_error = ?, feedback_kind = ?, resolved_at = ?, outcome_event_id = ?
         WHERE id = ?`,
      ).run(actual, error, input.feedbackKind, nowSec(), input.outcomeEventId?.trim().slice(0, 240) ?? null, row.id);
    } else {
      db.prepare(
        `UPDATE bot_predictions
         SET actual_sentiment = ?, prediction_error = ?, feedback_kind = ?, resolved_at = ?
         WHERE id = ?`,
      ).run(actual, error, input.feedbackKind, nowSec(), row.id);
    }
    appendPredictionModelRevision({
      db,
      predictionId: row.id,
      chatId: input.chatId,
      userId: dimensions ? (row.user_id ?? null) : null,
      actionType: dimensions ? (row.action_type ?? null) : null,
      outcomeEventId: input.outcomeEventId,
    });
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'resolvePrediction failed (non-critical)');
  }
}

/** Read the append-only calibration revision ledger for audit/evaluation. */
export function listPredictionModelRevisions(options: {
  chatId?: number;
  userId?: number | null;
  actionType?: string | null;
  limit?: number;
} = {}): PredictionModelRevision[] {
  try {
    const db = getDb();
    if (!hasTable(db, 'prediction_model_revisions')) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.chatId !== undefined) {
      where.push('chat_id = ?');
      params.push(options.chatId);
    }
    if (options.userId !== undefined) {
      where.push('((user_id = ?) OR (user_id IS NULL AND ? IS NULL))');
      params.push(options.userId, options.userId);
    }
    if (options.actionType !== undefined) {
      const actionType = options.actionType === null ? null : boundedActionType(options.actionType);
      if (options.actionType !== null && actionType === null) return [];
      where.push('((action_type = ?) OR (action_type IS NULL AND ? IS NULL))');
      params.push(actionType, actionType);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const rows = db.prepare(
      `SELECT id, chat_id, user_id, action_type, sample_count, mean_error, previous_bias,
              new_bias, source_prediction_id, outcome_event_id, created_at
         FROM prediction_model_revisions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      chatId: Number(row.chat_id),
      userId: row.user_id === null ? null : Number(row.user_id),
      actionType: row.action_type === null ? null : String(row.action_type),
      sampleCount: Number(row.sample_count),
      meanError: Number(row.mean_error),
      previousBias: Number(row.previous_bias),
      newBias: Number(row.new_bias),
      sourcePredictionId: Number(row.source_prediction_id),
      outcomeEventId: row.outcome_event_id === null ? null : String(row.outcome_event_id),
      createdAt: Number(row.created_at),
    }));
  } catch (err) {
    logger.debug({ err }, 'list prediction model revisions failed');
    return [];
  }
}

/** 最近已结算预测（供聚合 cron 计算 per-chat/per-task 平均误差）。 */
export function recentResolvedPredictions(limit = 200): Array<{
  id: number;
  chatId: number;
  userId: number | null;
  taskId: string | null;
  actionType: string | null;
  predictionError: number | null;
  feedbackKind: string | null;
  predictedSentiment?: number | null;
  actualSentiment?: number | null;
  predictionScale?: PredictionScale | null;
}> {
  try {
    const db = getDb();
    const extended = hasColumn(db, 'prediction_scale');
    const dimensions = hasColumn(db, 'user_id') && hasColumn(db, 'action_type');
    const rows = db
      .prepare(
        `SELECT id, chat_id, ${dimensions ? 'user_id, ' : ''}task_id, ${dimensions ? 'action_type, ' : ''}prediction_error, feedback_kind, predicted_sentiment, actual_sentiment${extended ? ', prediction_scale' : ''}
         FROM bot_predictions
         WHERE resolved_at IS NOT NULL AND prediction_error IS NOT NULL
         ORDER BY resolved_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      chatId: r.chat_id as number,
      userId: dimensions ? (r.user_id as number | null) ?? null : null,
      taskId: (r.task_id as string | null) ?? null,
      actionType: dimensions ? (r.action_type as string | null) ?? null : null,
      predictionError: (r.prediction_error as number | null) ?? null,
      feedbackKind: (r.feedback_kind as string | null) ?? null,
      predictedSentiment: (r.predicted_sentiment as number | null) ?? null,
      actualSentiment: (r.actual_sentiment as number | null) ?? null,
      predictionScale: extended ? (r.prediction_scale as PredictionScale | null) ?? null : null,
    }));
  } catch (err) {
    logger.warn({ err }, 'recentResolvedPredictions failed');
    return [];
  }
}

export interface PredictionCalibration {
  samples: number;
  meanError: number;
  meanAbsoluteError: number;
  rootMeanSquaredError: number;
}

/** Aggregate bounded calibration facts without updating long-term beliefs. */
export function summarizePredictionCalibration(chatId?: number, limit = 500): PredictionCalibration {
  const rows = recentResolvedPredictions(limit).filter((row) => chatId === undefined || row.chatId === chatId);
  const errors = rows.map((row) => row.predictionError).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!errors.length) return { samples: 0, meanError: 0, meanAbsoluteError: 0, rootMeanSquaredError: 0 };
  const sum = errors.reduce((total, value) => total + value, 0);
  const abs = errors.reduce((total, value) => total + Math.abs(value), 0);
  const square = errors.reduce((total, value) => total + value * value, 0);
  return {
    samples: errors.length,
    meanError: sum / errors.length,
    meanAbsoluteError: abs / errors.length,
    rootMeanSquaredError: Math.sqrt(square / errors.length),
  };
}

/** Group resolved prediction errors by chat/user/action without unbounded output. */
export function summarizePredictionCalibrationByDimension(options: PredictionDimensionFilter & {
  chatId?: number;
  limit?: number;
  maxGroups?: number;
} = {}): PredictionCalibrationDimension[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 1000), 1), 5000);
  const maxGroups = Math.min(Math.max(Math.trunc(options.maxGroups ?? 100), 1), 500);
  const actionType = options.actionType === undefined ? undefined : boundedActionType(options.actionType);
  if (options.actionType !== undefined && actionType === null) return [];
  const rows = recentResolvedPredictions(limit).filter((row) =>
    (options.chatId === undefined || row.chatId === options.chatId)
    && (options.userId === undefined || row.userId === options.userId)
    && (actionType === undefined || row.actionType === actionType),
  );
  const grouped = new Map<string, { chatId: number; userId: number | null; actionType: string | null; errors: number[] }>();
  for (const row of rows) {
    if (typeof row.predictionError !== 'number' || !Number.isFinite(row.predictionError)) continue;
    const key = `${row.chatId} ${row.userId ?? ''} ${row.actionType ?? ''}`;
    if (!grouped.has(key) && grouped.size >= maxGroups) break;
    const group = grouped.get(key) ?? { chatId: row.chatId, userId: row.userId, actionType: row.actionType, errors: [] };
    group.errors.push(row.predictionError);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => {
    const sum = group.errors.reduce((total, value) => total + value, 0);
    const abs = group.errors.reduce((total, value) => total + Math.abs(value), 0);
    const square = group.errors.reduce((total, value) => total + value * value, 0);
    return {
      chatId: group.chatId,
      userId: group.userId,
      actionType: group.actionType,
      calibration: {
        samples: group.errors.length,
        meanError: sum / group.errors.length,
        meanAbsoluteError: abs / group.errors.length,
        rootMeanSquaredError: Math.sqrt(square / group.errors.length),
      },
    };
  });
}
