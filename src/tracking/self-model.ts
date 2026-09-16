// ────────────────────────────────────────
// Self-Model Notes — 自我认知 (AGI Level 4 P4-C)
//
// bot 每天复盘自己最近 24h 的回复表现，产出 ≤5 条可操作的自我认知
// （「深夜别太热情」「技术问题直接给答案别卖萌」），注入回复 prompt。
// 没有 self-model 就没有真正的适应——只有每次重新掷骰子。
// ────────────────────────────────────────

import { getDb } from "../db/sqlite.js";
import { logger } from "../shared/logger.js";

export interface SelfNote {
  id: number;
  note: string;
  evidence: string | null;
  created_at: number;
  verified?: number;
}

type VerifiedSelfNoteInput = {
  sourceEventId: string;
  source: "host" | "tool" | "telegram" | "scheduler" | "import";
  evidence: Record<string, unknown>;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasTable(table: string): boolean {
  try {
    return Boolean(
      getDb()
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table),
    );
  } catch {
    return false;
  }
}

function recordCandidateAudit(
  notes: { note: string; evidence?: string }[],
): void {
  if (!hasTable("hypothesis_update_audit")) return;
  try {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO hypothesis_update_audit
       (idempotency_key, kind, scope_key, subject_key, source_event_id, source,
        status, reason, evidence_json, counterevidence_json, created_at)
       VALUES (?, 'self', 'global', 'bot', NULL, 'model', 'candidate', ?, ?, '[]', ?)`,
    );
    const ts = nowSec();
    for (const item of notes.slice(0, 5)) {
      const note = item.note.trim().slice(0, 300);
      if (!note) continue;
      stmt.run(
        `self-candidate:${ts}:${note}`.slice(0, 240),
        "model output retained for audit; not active evidence",
        JSON.stringify({
          note,
          evidence: item.evidence?.trim().slice(0, 500) ?? "",
        }).slice(0, 2000),
        ts,
      );
    }
  } catch (err) {
    logger.debug({ err }, "self-model candidate audit failed");
  }
}

/** 保存一批自我认知。空内容自动跳过。 */
export function saveSelfNotes(
  notes: { note: string; evidence?: string }[],
): number {
  let saved = 0;
  try {
    const stmt = getDb().prepare(
      `INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)`,
    );
    const ts = nowSec();
    for (const n of notes.slice(0, 5)) {
      const note = n.note?.trim().slice(0, 300);
      if (!note || note.length < 4) continue;
      stmt.run(note, n.evidence?.trim().slice(0, 500) ?? null, ts);
      saved++;
    }
    recordCandidateAudit(notes);
  } catch (err) {
    logger.warn({ err }, "saveSelfNotes failed");
  }
  return saved;
}

/** Save a Self hypothesis only after a host-owned evidence event passed the gate. */
export function saveVerifiedSelfNotes(
  notes: readonly { note: string; evidence?: string }[],
  provenance: VerifiedSelfNoteInput,
): number {
  if (!hasTable("self_model_note_evidence")) return 0;
  const eventId = provenance.sourceEventId.trim().slice(0, 240);
  if (
    !eventId ||
    !provenance.evidence ||
    Object.keys(provenance.evidence).length === 0
  )
    return 0;
  let saved = 0;
  try {
    const db = getDb();
    const ts = nowSec();
    const insert = db.prepare(
      "INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)",
    );
    const link = db.prepare(
      `INSERT INTO self_model_note_evidence (note_id, source_event_id, source, evidence_json, verified_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const n of notes.slice(0, 5)) {
      const note = n.note?.trim().slice(0, 300);
      if (!note || note.length < 4) continue;
      const row = insert.run(
        note,
        n.evidence?.trim().slice(0, 500) ?? null,
        ts,
      );
      link.run(
        Number(row.lastInsertRowid),
        eventId,
        provenance.source,
        JSON.stringify(provenance.evidence).slice(0, 2000),
        ts,
      );
      saved++;
    }
  } catch (err) {
    logger.warn({ err }, "saveVerifiedSelfNotes failed");
  }
  return saved;
}

/** 取最新的自我认知（注入 prompt 用）。 */
export function getActiveSelfNotes(limit = 5, asOfSec?: number): SelfNote[] {
  try {
    const boundedAsOf =
      Number.isSafeInteger(asOfSec) && (asOfSec as number) > 0
        ? asOfSec
        : undefined;
    const db = getDb();
    const verifiedJoin = hasTable("self_model_note_evidence")
      ? " JOIN self_model_note_evidence e ON e.note_id = n.id"
      : "";
    const verifiedColumn = hasTable("self_model_note_evidence")
      ? ", 1 AS verified"
      : "";
    return (
      boundedAsOf === undefined
        ? db
            .prepare(
              `SELECT n.*${verifiedColumn} FROM self_model_notes n${verifiedJoin} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
            )
            .all(limit)
        : db
            .prepare(
              `SELECT n.*${verifiedColumn} FROM self_model_notes n${verifiedJoin} WHERE n.created_at <= ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
            )
            .all(boundedAsOf, limit)
    ) as SelfNote[];
  } catch (err) {
    logger.debug({ err }, "getActiveSelfNotes failed (non-fatal)");
    return [];
  }
}

/** 淘汰旧笔记，保持窗口新鲜（默认保留最近 20 条）。 */
export function pruneSelfNotes(keep = 20): void {
  try {
    getDb()
      .prepare(
        `DELETE FROM self_model_notes WHERE id NOT IN (
           SELECT id FROM self_model_notes ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(keep);
  } catch (err) {
    logger.warn({ err }, "pruneSelfNotes failed");
  }
}
