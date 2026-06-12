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
import { runLearnerScan } from './learner-scan.js';
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

  // Scheduled messages execution — every minute
  tasks.push(schedule('* * * * *', () => {
    void safeRun('scheduled-messages', async () => {
      const { executeScheduledMessages } = await import('../pipeline/dm-relay/handlers/schedule.js');
      await executeScheduledMessages();
    });
  }));

  // Relay queue expiry — every 5 minutes
  tasks.push(schedule('*/5 * * * *', () => {
    void safeRun('relay-expiry', async () => {
      const { expireOldRelays } = await import('../pipeline/dm-relay/relay-queue.js');
      const count = expireOldRelays();
      if (count > 0) logger.info({ count }, 'Expired relay queue items');
    });
  }));

  // Scheduled relays — every minute, deliver due time-based relays
  tasks.push(schedule('* * * * *', () => {
    void safeRun('scheduled-relays', async () => {
      const { executeDueScheduledRelays } = await import('../pipeline/dm-relay/relay-queue.js');
      const count = await executeDueScheduledRelays();
      if (count > 0) logger.info({ count }, 'Delivered scheduled relays');
    });
  }));

  // Anonymous notes — close the 24h guess window (hint auto-drip removed; it spammed)
  tasks.push(schedule('17 * * * *', () => {
    void safeRun('note-close', async () => {
      const { closeExpiredNotes } = await import('../pipeline/dm-relay/handlers/note.js');
      const closed = await closeExpiredNotes();
      if (closed > 0) logger.info({ closed }, 'Note close tick');
    });
  }));

  // Behavioral role tagging — every 2h during active hours (8:00–22:00 CST-ish)
  tasks.push(schedule('23 8-22/2 * * *', () => {
    void safeRun('behavioral-roles', async () => {
      const { runRoleAnalysis } = await import('../tracking/behavioral-roles.js');
      const n = await runRoleAnalysis();
      if (n > 0) logger.info({ chats: n }, 'Behavioral roles tick');
    });
  }));

  // Memory "dream" — nightly forgetting of old, never-recalled memories
  tasks.push(schedule('41 4 * * *', () => {
    void safeRun('memory-dream', async () => {
      const { runMemoryDream } = await import('./memory-dream.js');
      const forgotten = await runMemoryDream();
      if (forgotten > 0) logger.info({ forgotten }, 'Memory dream tick');
    });
  }));

  // #8 关系叙事 — 每天给互动多的群友写/更新一句 "你和TA" 的共同经历概括
  tasks.push(schedule('19 5 * * *', () => {
    void safeRun('relationship-summarize', async () => {
      const { runRelationshipSummarize } = await import('./relationship-summarize.js');
      await runRelationshipSummarize();
    });
  }));

  // G7(语言生命)群共同经历 — 每 2 小时为活跃群提炼 0-2 条"群里发生的事"
  tasks.push(schedule('37 */2 * * *', () => {
    void safeRun('group-episodes', async () => {
      const { getRedis } = await import('../db/redis.js');
      const { summarizeEpisodes } = await import('../tracking/group-episodes.js');
      const raw = await getRedis().zrange('xxb:active_groups', -6, -1);
      for (const idStr of raw) {
        const chatId = Number(idStr);
        if (chatId < 0) await summarizeEpisodes(chatId).catch(() => {});
      }
    });
  }));

  // Expression learning gate — hourly auto-review of pending learned patterns
  tasks.push(schedule('51 * * * *', () => {
    void safeRun('expression-gate', async () => {
      const { runExpressionGate } = await import('../learners/expression-gate.js');
      const n = await runExpressionGate();
      if (n > 0) logger.info({ reviewed: n }, 'Expression gate tick');
    });
  }));

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

  // 硬作息心跳(v2):动态就寝 shift、晚安/早安边沿、半夜醒、补回排水
  // (问候由 SLEEP_ANNOUNCE_ENABLED 在函数内部单独控制,心跳必须常跑)
  if (env().SLEEP_SCHEDULE_ENABLED) {
    tasks.push(schedule('* * * * *', () => {
      void safeRun('sleep-cycle', async () => {
        const { runSleepCycle } = await import('./sleep-cycle.js');
        await runSleepCycle();
      });
    }));
  }

  // Proactive scan — periodic chat-aware engagement (Stage C)
  if (env().PROACTIVE_SCAN_ENABLED) {
    tasks.push(schedule(`*/${env().PROACTIVE_SCAN_INTERVAL_MIN} * * * *`, () => {
      void safeRun('proactive-scan', runProactiveScan);
    }));
  }

  // Learner scan — expression + jargon extraction (Stage D)
  if (env().LEARNER_ENABLED) {
    tasks.push(schedule(`*/${env().LEARNER_SCAN_INTERVAL_MIN} * * * *`, () => {
      void safeRun('learner-scan', runLearnerScan);
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
  'sleep-cycle': 60_000,
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
