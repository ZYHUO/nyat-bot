// ────────────────────────────────────────
// Experience Verifier — 经验验证打分 (AGI Level 5 Phase 1, ①)
//
// Practice Makes Unsafe 警告: 自我改进会放大「不安全的成功」——
// 一次侥幸成功被蒸馏成经验后永久复用。验证器给经验加反馈闭环:
// 经验被注入 → 任务终态 → 打分 → verified 状态。
// 结果好但路径脏(done + path_quality < 0.7)不算证实。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { isPathQualityGood } from './path-quality.js';

export type VerifiedState = 0 | 1 | 2; // 0=未知 1=已证实 2=可疑

export interface InjectOutcomeArgs {
  experienceIds: number[];
  taskOutcome: 'done' | 'failed';
  pathQualityScore: number;
  minSuccess?: number;
  /** Host-side acceptance, never inferred from endTask summary. */
  evidenceStatus?: 'verified' | 'failed' | 'unverified';
}

/** 记录一次注入后任务结果。返回更新到的 verified 状态(按 id)。 */
export function recordInjectOutcome(args: InjectOutcomeArgs): Map<number, VerifiedState> {
  const { experienceIds, taskOutcome, pathQualityScore, minSuccess = 2 } = args;
  const states = new Map<number, VerifiedState>();
  if (!experienceIds.length) return states;
  try {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      `UPDATE experience_entries
       SET success_count = success_count + ?, failure_count = failure_count + ?,
           last_verified_at = ?, verified = ?
       WHERE id = ?`,
    );
    const read = db.prepare(`SELECT verified, success_count, failure_count FROM experience_entries WHERE id = ?`);
    for (const id of experienceIds) {
      const good = args.evidenceStatus === 'verified' && taskOutcome === 'done' && isPathQualityGood(pathQualityScore);
      const fail = args.evidenceStatus === 'failed' && taskOutcome === 'failed';
      const incS = good ? 1 : 0;
      const incF = fail ? 1 : 0;
      if (incS === 0 && incF === 0) continue; // done 但路径脏: 不计数
      stmt.run(incS, incF, now, 0, id); // 先清 verified,下面重算
      const row = read.get(id) as { verified: number; success_count: number; failure_count: number } | undefined;
      if (!row) continue;
      let v: VerifiedState = row.verified as VerifiedState;
      if (row.failure_count >= 2) v = 2;
      else if (row.success_count >= minSuccess && row.failure_count === 0) v = 1;
      else v = 0;
      if (v !== row.verified) {
        db.prepare(`UPDATE experience_entries SET verified = ? WHERE id = ?`).run(v, id);
      }
      states.set(id, v);
    }
    return states;
  } catch (err) {
    logger.warn({ err }, 'recordInjectOutcome failed');
    return states;
  }
}

/** 检索时对 verified=2 的经验降权(排最后)。 */
export function verifyRankSql(): string {
  // verified=2 排最后, verified=1 优先, 未知居中
  return `ORDER BY CASE verified WHEN 2 THEN 2 WHEN 1 THEN 0 ELSE 1 END, use_count DESC`;
}

