import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface TaskEvidenceRecord {
  taskId: string;
  chatId: number;
  lifecycle: string;
  assessment: 'verified' | 'failed' | 'unverified';
  turns: number;
  totalCalls: number;
  failedCalls: number;
  retryCount: number;
  /** Host-generated reason codes only, never tool output or user content. */
  reasons: string[];
}

/** Durable evaluation sidecar. Failure must not turn an unknown task into success. */
export function saveTaskEvidence(record: TaskEvidenceRecord): boolean {
  try {
    if (![record.turns, record.totalCalls, record.failedCalls, record.retryCount]
      .every((n) => Number.isSafeInteger(n) && n >= 0) || record.failedCalls > record.totalCalls) return false;
    const result = getDb().prepare(`INSERT INTO task_evidence
      (task_id, chat_id, lifecycle, assessment, turns, total_calls, failed_calls, retry_count, reasons, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        lifecycle=excluded.lifecycle, assessment=excluded.assessment, turns=excluded.turns,
        total_calls=excluded.total_calls, failed_calls=excluded.failed_calls,
        retry_count=excluded.retry_count, reasons=excluded.reasons, updated_at=excluded.updated_at
      WHERE task_evidence.chat_id = excluded.chat_id`)
      .run(record.taskId, record.chatId, record.lifecycle, record.assessment, record.turns,
        record.totalCalls, record.failedCalls, record.retryCount,
        JSON.stringify(record.reasons.slice(0, 8).map((reason) => reason.slice(0, 160))),
        Math.floor(Date.now() / 1000));
    return result.changes === 1;
  } catch {
    logger.warn({ taskId: record.taskId }, 'task evidence persistence failed');
    return false;
  }
}
