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

/** bot 交付消息时登记预测。message_id 用于后续反馈归因。 */
export function recordPrediction(input: {
  chatId: number;
  taskId?: string;
  messageId?: number;
  source?: 'system_prior' | 'model';
  prediction?: string;
  predictedSentiment?: number;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO bot_predictions (chat_id, task_id, message_id, source, prediction, predicted_sentiment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.chatId,
        input.taskId ?? null,
        input.messageId ?? null,
        input.source ?? 'system_prior',
        input.prediction?.slice(0, 400) ?? null,
        Math.min(1, Math.max(0, input.predictedSentiment ?? 0.5)),
        nowSec(),
      );
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
}): void {
  const actual = Math.min(1, Math.max(-1, input.actualSentiment));
  try {
    const row = getDb()
      .prepare(
        `SELECT id, predicted_sentiment FROM bot_predictions
         WHERE chat_id = ? AND message_id = ? AND resolved_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(input.chatId, input.messageId) as { id: number; predicted_sentiment: number } | undefined;
    if (!row) return;
    const error = actual - row.predicted_sentiment;
    getDb()
      .prepare(
        `UPDATE bot_predictions
         SET actual_sentiment = ?, prediction_error = ?, feedback_kind = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(actual, error, input.feedbackKind, nowSec(), row.id);
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'resolvePrediction failed (non-critical)');
  }
}

/** 最近已结算预测（供聚合 cron 计算 per-chat/per-task 平均误差）。 */
export function recentResolvedPredictions(limit = 200): Array<{
  id: number; chatId: number; taskId: string | null; predictionError: number | null; feedbackKind: string | null;
}> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, chat_id, task_id, prediction_error, feedback_kind FROM bot_predictions
         WHERE resolved_at IS NOT NULL AND prediction_error IS NOT NULL
         ORDER BY resolved_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      chatId: r.chat_id as number,
      taskId: (r.task_id as string | null) ?? null,
      predictionError: (r.prediction_error as number | null) ?? null,
      feedbackKind: (r.feedback_kind as string | null) ?? null,
    }));
  } catch (err) {
    logger.warn({ err }, 'recentResolvedPredictions failed');
    return [];
  }
}
