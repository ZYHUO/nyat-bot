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

/**
 * 用 host 观测到的「有没有人接」给无 contract 的任务补证据。
 *
 * 群聊任务没有 caller 契约，task_evidence.assessment 恒为 unverified（7038 / 7039），
 * 经验→技能这条链因此一直没有独立信号。但 host 自己看得到一件事：这个任务发出的每条消息
 * 最后怎么样了（self_replies.outcome，由 tracking/outcome.ts 结算）。这是 host 的观测，
 * 不是模型自评，符合「LLM 不能自证」。
 *
 * 聚合（一个任务可能发多条，结局不一）：
 *   · 任何一条 corrected                        → failed
 *   · 有一条被接住（replied/mentioned/reacted）  → verified（且无 corrected）
 *   · 全部已结算且全是 ignored                   → failed
 *   · 其余（还有 unknown 未结算 / 无发送）        → 保持 unverified
 *
 * **只升级 unverified 行。** 已经是 verified/failed 的（caller 契约给的）一律不动，
 * 所以这不会削弱原有证据门。原因写进 reasons，带 `host_echo:` 前缀以便和契约来源区分。
 */
export function applyEchoEvidence(taskId: string): 'verified' | 'failed' | 'unchanged' {
  try {
    const db = getDb();
    const ev = db.prepare(`SELECT assessment, reasons FROM task_evidence WHERE task_id = ?`)
      .get(taskId) as { assessment?: string; reasons?: string } | undefined;
    if (!ev || ev.assessment !== 'unverified') return 'unchanged';

    const rows = db.prepare(`SELECT outcome FROM self_replies WHERE task_id = ?`)
      .all(taskId) as Array<{ outcome: string }>;
    if (!rows.length) return 'unchanged';

    const outcomes = rows.map((r) => r.outcome);
    const landed = outcomes.some((o) => o === 'replied' || o === 'mentioned' || o === 'reacted');
    const corrected = outcomes.some((o) => o === 'corrected');

    // every(ignored) 已隐含「没有未结算的 unknown」，不需要再单独守一次。
    let next: 'verified' | 'failed' | null = null;
    if (corrected) next = 'failed';
    else if (landed) next = 'verified';
    else if (outcomes.every((o) => o === 'ignored')) next = 'failed';
    if (!next) return 'unchanged';

    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(ev.reasons ?? '[]') as unknown;
      if (Array.isArray(parsed)) reasons = parsed.filter((r): r is string => typeof r === 'string');
    } catch { /* start from empty */ }
    const tag = `host_echo:${next === 'verified' ? 'landed' : corrected ? 'corrected' : 'all_ignored'}`;
    reasons = [...reasons.filter((r) => !r.startsWith('host_echo:')), tag].slice(-8);

    const res = db.prepare(
      `UPDATE task_evidence SET assessment = ?, reasons = ?, updated_at = ?
       WHERE task_id = ? AND assessment = 'unverified'`,
    ).run(next, JSON.stringify(reasons), Math.floor(Date.now() / 1000), taskId) as { changes?: number };
    if (res.changes !== 1) return 'unchanged';

    if (next === 'verified') {
      void import('./skills.js')
        .then(({ recordSkillVerifiedUseForTask }) => recordSkillVerifiedUseForTask(taskId))
        .catch(() => { /* non-critical */ });
    }
    logger.info({ taskId, assessment: next, outcomes }, 'task evidence upgraded from host echo');
    return next;
  } catch (err) {
    logger.debug({ err, taskId }, 'applyEchoEvidence failed (non-critical)');
    return 'unchanged';
  }
}
