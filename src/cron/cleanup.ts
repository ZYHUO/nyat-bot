// ────────────────────────────────────────
// Data cleanup — expired contexts, old logs
// ────────────────────────────────────────

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import { pruneReviewed } from '../allowlist/allowlist.js';
import { pruneOldSelfReplies } from '../tracking/self-history.js';
import { getDb } from '../db/sqlite.js';

export interface CleanupDeps {
  redis: Redis;
  allowlistConfig: AllowlistConfig;
}

/**
 * 审计 #40:append-only 日志表的真实 retention(此前只有吹牛的注释)。
 * 单实例 SQLite 上这些表只进不出 = 单调增长的磁盘/延迟回归:
 *   reply_outcomes(每次回复一行,最大头)/ relay_log / reputation_log
 *   → 90 天;fate_history → 90 天(created_at 是 DATETIME 文本);
 *   daily_stats(每群每天一行)/ reply_reflections(每群一行,顺手清
 *   不活跃群)→ 180 天。
 * unix 秒列直接数值比较;DATETIME/DATE 文本列转成同格式文本字典序比较。
 * 每张表独立 try/catch —— 某表缺失(老库/测试库)不拖累其余。
 */
export function pruneLogRetention(): void {
  const now = Math.floor(Date.now() / 1000);
  const d90 = now - 90 * 86400;
  const d180 = now - 180 * 86400;
  const jobs: Array<{ table: string; sql: string; cutoff: number }> = [
    { table: 'reply_outcomes', sql: 'DELETE FROM reply_outcomes WHERE ts < ?', cutoff: d90 },
    { table: 'relay_log', sql: 'DELETE FROM relay_log WHERE created_at < ?', cutoff: d90 },
    { table: 'reputation_log', sql: 'DELETE FROM reputation_log WHERE created_at < ?', cutoff: d90 },
    // fate_history.created_at 是 CURRENT_TIMESTAMP 文本('YYYY-MM-DD HH:MM:SS')
    { table: 'fate_history', sql: "DELETE FROM fate_history WHERE created_at < datetime(?, 'unixepoch')", cutoff: d90 },
    // daily_stats.date 是 'YYYY-MM-DD' 文本,ISO 字典序可比
    { table: 'daily_stats', sql: "DELETE FROM daily_stats WHERE date < date(?, 'unixepoch')", cutoff: d180 },
    { table: 'reply_reflections', sql: 'DELETE FROM reply_reflections WHERE updated_at < ?', cutoff: d180 },
  ];
  for (const { table, sql, cutoff } of jobs) {
    try {
      const r = getDb().prepare(sql).run(cutoff);
      if (r.changes > 0) logger.info({ table, deleted: r.changes }, 'Log retention pruned');
    } catch (err) {
      logger.warn({ err, table }, 'Log retention prune failed');
    }
  }
}

export async function runCleanup(deps?: CleanupDeps): Promise<void> {
  // Cleanup tasks (best-effort, errors are caught internally).
  // Redis context / pending buffers are NOT handled here — they expire via
  // rolling TTLs at the write sites (context/manager.ts, turn/buffer.ts).

  // 4. Prune reviewed allowlist entries older than 30 days
  if (deps) {
    try {
      await pruneReviewed(deps.redis, deps.allowlistConfig);
    } catch (err) {
      logger.warn({ err }, 'Failed to prune reviewed entries');
    }
  }

  // 5. Clean up stale submit dedup locks
  // (Handled by Redis TTL on the lock keys)

  // 6.5 G10: prune stale single-occurrence learnings (expressions/jargons)
  try {
    const { pruneStaleLearnings } = await import('../learners/expression-learner.js');
    pruneStaleLearnings();
  } catch (err) {
    logger.warn({ err }, 'Failed to prune stale learnings');
  }

  // 7. Stage F: prune old self-replies (>60 days)
  try {
    pruneOldSelfReplies(60);
  } catch (err) {
    logger.warn({ err }, 'Failed to prune old self-replies');
  }

  // 8. Log-table retention (audit #40)
  pruneLogRetention();

  logger.info('Cleanup job completed');
}
