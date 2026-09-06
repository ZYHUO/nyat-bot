// ────────────────────────────────────────
// Core v2 Phase 4 — skill 剪枝 + 调用统计
//
// 剪枝规则（host 确定性，LLM 不参与）：
//   1. proposed 超过 30 天没人 verify → rejected（候选过期，防堆积）。
//      注意：rejected 行保留（审计），不删。
//   2. published 但 skills 表里 archived=1（被大 skill 回收）→ 保持
//      published（历史），不碰。
//   3. skills 旧表的大库上限淘汰沿用 pruneBigSkills（不动）。
//
// 调用统计：published 的 skill 每次被 findRelevantSkills 命中，
// use_count++（旧行为，沿用）；verified_use_count 只有 host-verified
// task 才加（旧行为，沿用）。这里只加一个只读聚合给验收看。
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';

export interface PruneResult {
  expired: number;
}

/**
 * 过期候选回收：proposed 超过 maxAgeSec（默认 30d）→ rejected。
 * 返回回收数。幂等，可定期跑（cron 或 tick 里顺手调）。
 */
export function pruneExpiredProposals(maxAgeSec = 30 * 86400): PruneResult {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const r = getDb()
      .prepare(
        `UPDATE core_skill_lifecycle SET status = 'rejected',
         verify_log = 'pruned: proposal expired (>30d without verify)',
         updated_at = ?
         WHERE status = 'proposed' AND created_at < ?`,
      )
      .run(Math.floor(Date.now() / 1000), cutoff);
    return { expired: Number(r.changes) };
  } catch (err) {
    logger.debug({ err }, 'pruneExpiredProposals failed (non-critical)');
    return { expired: 0 };
  }
}

export interface LifecycleStats {
  proposed: number;
  verified: number;
  approved: number;
  published: number;
  rejected: number;
}

/** 各状态计数（验收/观测用，只读）。 */
export function lifecycleStats(): LifecycleStats {
  const zero: LifecycleStats = { proposed: 0, verified: 0, approved: 0, published: 0, rejected: 0 };
  try {
    const rows = getDb()
      .prepare(`SELECT status, COUNT(*) c FROM core_skill_lifecycle GROUP BY status`)
      .all() as { status: string; c: number }[];
    for (const r of rows) {
      if (r.status in zero) zero[r.status as keyof LifecycleStats] = r.c;
    }
    return zero;
  } catch {
    return zero;
  }
}
