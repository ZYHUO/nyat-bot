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

export interface TaskEvidenceSnapshot extends TaskEvidenceRecord {
  updatedAt: number;
}

function normalizeTaskId(taskId: string): string | null {
  const normalized = typeof taskId === 'string' ? taskId.trim() : '';
  return normalized.length > 0 && normalized.length <= 120 ? normalized : null;
}

/** Read host-generated acceptance metadata without exposing task content. */
export function getTaskEvidence(taskId: string, chatId?: number): TaskEvidenceSnapshot | null {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!normalizedTaskId) return null;
  if (chatId !== undefined && (!Number.isSafeInteger(chatId) || chatId === 0)) return null;
  try {
    const row = getDb().prepare(
      `SELECT task_id, chat_id, lifecycle, assessment, turns, total_calls,
              failed_calls, retry_count, reasons, updated_at
         FROM task_evidence
        WHERE task_id = ?${chatId === undefined ? '' : ' AND chat_id = ?'}
        LIMIT 1`,
    ).get(...(chatId === undefined ? [normalizedTaskId] : [normalizedTaskId, chatId])) as Record<string, unknown> | undefined;
    if (!row) return null;
    const assessment = row['assessment'];
    if (assessment !== 'verified' && assessment !== 'failed' && assessment !== 'unverified') return null;
    const rowChatId = Number(row['chat_id']);
    const turns = Number(row['turns']);
    const totalCalls = Number(row['total_calls']);
    const failedCalls = Number(row['failed_calls']);
    const retryCount = Number(row['retry_count']);
    const updatedAt = Number(row['updated_at']);
    if (!Number.isSafeInteger(rowChatId) || rowChatId === 0
      || ![turns, totalCalls, failedCalls, retryCount, updatedAt]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(String(row['reasons'] ?? '[]')) as unknown;
      if (Array.isArray(parsed)) {
        reasons = parsed
          .filter((reason): reason is string => typeof reason === 'string')
          .map((reason) => reason.trim().slice(0, 160))
          .filter(Boolean)
          .slice(0, 8);
      }
    } catch {
      reasons = [];
    }
    return {
      taskId: String(row['task_id']),
      chatId: rowChatId,
      lifecycle: String(row['lifecycle']).slice(0, 40),
      assessment,
      turns,
      totalCalls,
      failedCalls,
      retryCount,
      reasons,
      updatedAt,
    };
  } catch {
    return null;
  }
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
