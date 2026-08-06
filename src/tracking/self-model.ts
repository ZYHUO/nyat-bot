// ────────────────────────────────────────
// Self-Model Notes — 自我认知 (AGI Level 4 P4-C)
//
// bot 每天复盘自己最近 24h 的回复表现，产出 ≤5 条可操作的自我认知
// （「深夜别太热情」「技术问题直接给答案别卖萌」），注入回复 prompt。
// 没有 self-model 就没有真正的适应——只有每次重新掷骰子。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface SelfNote {
  id: number;
  note: string;
  evidence: string | null;
  created_at: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 保存一批自我认知。空内容自动跳过。 */
export function saveSelfNotes(notes: { note: string; evidence?: string }[]): number {
  let saved = 0;
  try {
    const stmt = getDb().prepare(`INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)`);
    const ts = nowSec();
    for (const n of notes.slice(0, 5)) {
      const note = n.note?.trim().slice(0, 300);
      if (!note || note.length < 4) continue;
      stmt.run(note, n.evidence?.trim().slice(0, 500) ?? null, ts);
      saved++;
    }
  } catch (err) {
    logger.warn({ err }, 'saveSelfNotes failed');
  }
  return saved;
}

/** 取最新的自我认知（注入 prompt 用）。 */
export function getActiveSelfNotes(limit = 5): SelfNote[] {
  try {
    return getDb()
      .prepare(`SELECT * FROM self_model_notes ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as SelfNote[];
  } catch (err) {
    logger.debug({ err }, 'getActiveSelfNotes failed (non-fatal)');
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
    logger.warn({ err }, 'pruneSelfNotes failed');
  }
}
