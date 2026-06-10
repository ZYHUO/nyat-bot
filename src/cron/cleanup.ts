// ────────────────────────────────────────
// Data cleanup — expired contexts, old logs
// ────────────────────────────────────────

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import type { AllowlistConfig } from '../allowlist/types.js';
import { pruneReviewed } from '../allowlist/allowlist.js';
import { cleanExpired } from '../tracking/topic-watch.js';
import { pruneOldSelfReplies } from '../tracking/self-history.js';

export interface CleanupDeps {
  redis: Redis;
  allowlistConfig: AllowlistConfig;
}

export async function runCleanup(deps?: CleanupDeps): Promise<void> {
  // Cleanup tasks (best-effort, errors are caught internally):
  // 1. Remove expired Redis context entries beyond retention
  // 2. Trim old reply_outcomes beyond threshold
  // 3. Clean up stale pending entries

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

  // 6. Clean expired topic watches
  try {
    cleanExpired();
  } catch (err) {
    logger.warn({ err }, 'Failed to clean expired topic watches');
  }

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

  logger.info('Cleanup job completed');
}
