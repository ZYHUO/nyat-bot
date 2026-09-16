// ────────────────────────────────────────
// Dreaming cron — 每周经验整合 (AGI Level 5 Phase 2)
// 周日 04:17 低峰跑一次 runDreamOnce。失败静默,下次周期再试。
// ────────────────────────────────────────

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { runDreamOnce } from '../agent/dreaming.js';

export async function runDreamConsolidate(): Promise<void> {
  if (!env().DREAM_CONSOLIDATE_ENABLED) return;
  try {
    const r = await runDreamOnce();
    if (r) {
      logger.info({ merges: r.merges.length, conflicts: r.conflicts.length, drops: r.drops.length }, 'dream consolidate done');
    }
  } catch (err) {
    logger.warn({ err }, 'dream consolidate failed');
  }
}
