// ────────────────────────────────────────
// Cron scheduler — node-cron based, with setInterval fallback
// Replaces PHP crontab-based cron_handler.php
// ────────────────────────────────────────

import { schedule, validate } from 'node-cron';
import { env } from '../env.js';
import { runDailyReport } from './report.js';
import { runModelCheck } from './model-check.js';
import { runCleanup, type CleanupDeps } from './cleanup.js';
import { runKnowledgeSync } from './knowledge-sync.js';
import { runUserProfileSync } from '../tracking/user-profile.js';
import { runIdleCheck } from './idle.js';
import { runProactiveScan } from './proactive-scan.js';
import { runChannelSync } from './channel-sync.js';
import { flushDailyStats } from '../tracking/stats.js';
import { logger } from '../shared/logger.js';

export interface CronDeps {
  cleanupDeps?: CleanupDeps;
}

const tasks: ReturnType<typeof schedule>[] = [];
let _started = false;
let _deps: CronDeps = {};

export function startCronJobs(deps?: CronDeps): void {
  if (_started) return;
  _started = true;
  if (deps) _deps = deps;

  const enabled = process.env['CRON_ENABLED'] !== 'false' && process.env['CRON_ENABLED'] !== '0';
  if (!enabled) {
    logger.info('Cron jobs disabled via CRON_ENABLED');
    return;
  }

  // Model status check — every 5 minutes
  tasks.push(schedule('*/5 * * * *', () => {
    void safeRun('model-check', runModelCheck);
  }));

  // Daily report — every day at 23:55 Beijing time (15:55 UTC)
  tasks.push(schedule('55 15 * * *', () => {
    void safeRun('daily-report', runDailyReport);
  }));

  // Cleanup — every 6 hours
  tasks.push(schedule('0 */6 * * *', () => {
    void safeRun('cleanup', () => runCleanup(_deps.cleanupDeps));
  }));

  // Verification timeout cleanup — every minute
  if (env().VERIFY_ENABLED) {
    tasks.push(schedule('* * * * *', () => {
      void safeRun('verify-cleanup', async () => {
        const { cleanupTimedOutVerifications } = await import('../verification/cleanup.js');
        const { getBot } = await import('../bot/bot.js');
        const bot = getBot();
        if (bot) await cleanupTimedOutVerifications(bot);
      });
    }));
  }

  // Knowledge base sync — configurable (PHP cron_long_term.php); only runs when chat IDs set
  const ks = env().KNOWLEDGE_CRON_SCHEDULE;
  if (validate(ks)) {
    tasks.push(
      schedule(ks, () => {
        void safeRun('knowledge-sync', runKnowledgeSync);
      }),
    );
  } else {
    logger.warn({ expr: ks }, 'Invalid KNOWLEDGE_CRON_SCHEDULE, knowledge-sync cron disabled');
  }

  // User profile sync — every hour, Qwen3.6+ summarizes pending messages per user
  tasks.push(schedule('7 * * * *', () => {
    void safeRun('user-profile-sync', runUserProfileSync);
  }));

  // Idle proactive messaging — every 5 minutes, poke silent group chats
  tasks.push(schedule('*/5 * * * *', () => {
    void safeRun('idle-check', runIdleCheck);
  }));

  // Proactive scan — periodic chat-aware engagement (Stage C)
  if (env().PROACTIVE_SCAN_ENABLED) {
    tasks.push(schedule(`*/${env().PROACTIVE_SCAN_INTERVAL_MIN} * * * *`, () => {
      void safeRun('proactive-scan', runProactiveScan);
    }));
  }

  // Channel source scraping — every 30 minutes, fetch public channel posts into ChromaDB
  tasks.push(schedule('*/30 * * * *', () => {
    void safeRun('channel-sync', runChannelSync);
  }));

  // Daily stats flush — every hour
  tasks.push(schedule('0 * * * *', () => {
    void safeRun('stats-flush', async () => { flushDailyStats(); });
  }));

  logger.info({ jobCount: tasks.length }, 'Cron jobs started');
}

export function stopCronJobs(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
  _started = false;
  logger.info('Cron jobs stopped');
}

export function isStarted(): boolean {
  return _started;
}

const CRON_TIMEOUT_MS: Record<string, number> = {
  'model-check': 60_000,
  'daily-report': 5 * 60_000,
  'cleanup': 5 * 60_000,
  'knowledge-sync': 15 * 60_000,
  'user-profile-sync': 10 * 60_000,
  'idle-check': 60_000,
  'channel-sync': 10 * 60_000,
};
const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;

const _running = new Set<string>();

async function safeRun(name: string, fn: () => Promise<void>): Promise<void> {
  if (_running.has(name)) {
    logger.warn({ name }, 'Cron job already running, skipping');
    return;
  }
  _running.add(name);
  const start = performance.now();
  const timeoutMs = CRON_TIMEOUT_MS[name] ?? DEFAULT_CRON_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Cron job ${name} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    await Promise.race([fn(), timeout]);
    const durationMs = Math.round(performance.now() - start);
    logger.debug({ name, durationMs }, 'Cron job completed');
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    logger.error({ err, name, durationMs, timeoutMs }, 'Cron job failed');
  } finally {
    if (timer) clearTimeout(timer);
    _running.delete(name);
  }
}
