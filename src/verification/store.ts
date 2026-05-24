import type Database from 'better-sqlite3';
import type { Challenge } from './challenge.js';

export interface VerifySettings {
  chat_id: number;
  enabled: boolean;
  timeout_seconds: number;
  max_attempts: number;
  kick_on_fail: boolean;
  updated_at: number;
}

export interface VerifyRecord {
  id: number;
  chat_id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  challenge_type: string;
  challenge_json: string;
  status: 'pending' | 'passed' | 'failed' | 'timeout' | 'kicked';
  attempts: number;
  started_at: number;
  completed_at: number | null;
  dm_message_id: number | null;
}

// ── Settings ──

export function getVerifySettings(
  db: Database.Database,
  chatId: number,
): VerifySettings | null {
  const row = db.prepare(
    'SELECT * FROM group_verify_settings WHERE chat_id = ?',
  ).get(chatId) as VerifySettings | undefined;
  return row ?? null;
}

export function setVerifyEnabled(
  db: Database.Database,
  chatId: number,
  enabled: boolean,
): void {
  db.prepare(`
    INSERT INTO group_verify_settings (chat_id, enabled, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(chatId, enabled ? 1 : 0);
}

export function setVerifyConfig(
  db: Database.Database,
  chatId: number,
  config: Partial<Pick<VerifySettings, 'timeout_seconds' | 'max_attempts' | 'kick_on_fail'>>,
): void {
  const existing = getVerifySettings(db, chatId);
  if (!existing) {
    db.prepare(`
      INSERT INTO group_verify_settings (chat_id, timeout_seconds, max_attempts, kick_on_fail, updated_at)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
    `).run(
      chatId,
      config.timeout_seconds ?? 300,
      config.max_attempts ?? 3,
      config.kick_on_fail ? 1 : 0,
    );
  } else {
    db.prepare(`
      UPDATE group_verify_settings SET
        timeout_seconds = ?,
        max_attempts = ?,
        kick_on_fail = ?,
        updated_at = strftime('%s','now')
      WHERE chat_id = ?
    `).run(
      config.timeout_seconds ?? existing.timeout_seconds,
      config.max_attempts ?? existing.max_attempts,
      config.kick_on_fail !== undefined ? (config.kick_on_fail ? 1 : 0) : existing.kick_on_fail,
      chatId,
    );
  }
}

// ── Records ──

export function createVerifyRecord(
  db: Database.Database,
  params: {
    chat_id: number;
    user_id: number;
    username?: string;
    first_name?: string;
    challenge: Challenge;
    max_attempts: number;
  },
): number {
  const result = db.prepare(`
    INSERT INTO verify_records (chat_id, user_id, username, first_name, challenge_type, challenge_json, attempts)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(
    params.chat_id,
    params.user_id,
    params.username ?? null,
    params.first_name ?? null,
    params.challenge.type,
    JSON.stringify(params.challenge),
  );
  return Number(result.lastInsertRowid);
}

export function getPendingRecord(
  db: Database.Database,
  chatId: number,
  userId: number,
): VerifyRecord | null {
  const row = db.prepare(
    'SELECT * FROM verify_records WHERE chat_id = ? AND user_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1',
  ).get(chatId, userId, 'pending') as VerifyRecord | undefined;
  return row ?? null;
}

export function getRecordById(
  db: Database.Database,
  recordId: number,
): VerifyRecord | null {
  const row = db.prepare(
    'SELECT * FROM verify_records WHERE id = ?',
  ).get(recordId) as VerifyRecord | undefined;
  return row ?? null;
}

export function incrementAttempt(
  db: Database.Database,
  recordId: number,
  newChallenge: Challenge,
): void {
  db.prepare(`
    UPDATE verify_records SET
      attempts = attempts + 1,
      challenge_json = ?,
      challenge_type = ?
    WHERE id = ?
  `).run(JSON.stringify(newChallenge), newChallenge.type, recordId);
}

export function updateRecordStatus(
  db: Database.Database,
  recordId: number,
  status: VerifyRecord['status'],
): void {
  db.prepare(`
    UPDATE verify_records SET
      status = ?,
      completed_at = CASE WHEN ? IN ('passed', 'failed', 'timeout', 'kicked') THEN strftime('%s','now') ELSE completed_at END
    WHERE id = ?
  `).run(status, status, recordId);
}

export function updateDmMessageId(
  db: Database.Database,
  recordId: number,
  messageId: number,
): void {
  db.prepare(
    'UPDATE verify_records SET dm_message_id = ? WHERE id = ?',
  ).run(messageId, recordId);
}

export function getTimedOutRecords(
  db: Database.Database,
): VerifyRecord[] {
  return db.prepare(`
    SELECT * FROM verify_records
    WHERE status = 'pending'
      AND started_at < strftime('%s','now') - (
        SELECT COALESCE(gs.timeout_seconds, 300)
        FROM group_verify_settings gs
        WHERE gs.chat_id = verify_records.chat_id
      )
  `).all() as VerifyRecord[];
}

export function getRecentStats(
  db: Database.Database,
  chatId: number,
  since: number,
): { total: number; passed: number; failed: number; pending: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN status IN ('failed', 'kicked', 'timeout') THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM verify_records
    WHERE chat_id = ? AND started_at > ?
  `).get(chatId, since) as { total: number; passed: number; failed: number; pending: number };
  return row ?? { total: 0, passed: 0, failed: 0, pending: 0 };
}
