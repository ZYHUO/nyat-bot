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
// idle.ts / proactive-thinker.ts / self-play.ts / goal-check.ts / proactive-scan.ts
// 已被 unified-tick 取代并删除；活跃时段判断在 active-hours.ts。
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

  const enabled = env().CRON_ENABLED;
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

  // token 记账日报 — 每天把昨天/今天各 provider 的 token 消耗打进 info 日志
  // (StepFun 用了多少一目了然)。持久化在 llm_token_daily,重启不丢。
  tasks.push(schedule('3 0 * * *', () => {
    void safeRun('token-report', async () => {
      const { getTokenReport } = await import('../metrics/token-ledger.js');
      const now = new Date();
      const yday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
      for (const d of [yday, now.toISOString().slice(0, 10)]) {
        const r = getTokenReport(d);
        logger.info(
          { date: r.date, total: r.total.total, byLabel: r.byLabel.map((x) => ({ label: x.label, total: x.total, cached: x.cached })) },
          'token ledger daily report',
        );
      }
    });
  }));

  // 机制5:LLM 全局画像合并。C:从每天一次改为**每 2 小时**(配 PROFILE_MERGE_STALE_HOURS
  // 水位线 + PROFILE_MERGE_MAX_UIDS 批量),全局画像更新更勤 + 更充分消耗配额。默认关灰度。
  if (env().PROFILE_MERGE_ENABLED) {
    tasks.push(schedule('31 */2 * * *', () => {
      void safeRun('profile-merge', async () => {
        const { runProfileMerge } = await import('./profile-merge.js');
        await runProfileMerge();
      });
    }));
  }

  // 深度反思(A)—— 对活跃群提炼"本群近况"注入回复;吞吐可调(REFLECTION_*),
  // 把 StepFun 配额花在"让 bot 记住群里发生过什么"。默认关。
  if (env().REFLECTION_ENABLED) {
    tasks.push(schedule(`*/${env().REFLECTION_INTERVAL_MIN} * * * *`, () => {
      void safeRun('deep-reflection', async () => {
        const { runDeepReflection } = await import('./deep-reflection.js');
        await runDeepReflection();
      });
    }));
  }

  // StepFun 配额消费引擎(滚动深反思)—— 每分钟拉一批全池工作项(群反思+跨上下文合并)
  // 并发跑,把订阅配额用起来(冲 ~100M/天)。速率/并发/权重全可调,默认关。
  if (env().STEPFUN_CONSUMER_ENABLED) {
    tasks.push(schedule('* * * * *', () => {
      void safeRun('stepfun-consumer', async () => {
        const { runStepfunConsumer } = await import('./stepfun-consumer.js');
        await runStepfunConsumer();
      });
    }));
  }

  // 功能 A3:每日「今日感想」生成(每小时跑,内部按 BJ 日去重,只生成一次)。
  if (env().SCHOOL_SCHEDULE_ENABLED) {
    tasks.push(schedule('40 * * * *', () => {
      void safeRun('school-day-plan', async () => {
        const { runSchoolDayPlan } = await import('./school-day-plan.js');
        await runSchoolDayPlan();
      });
    }));
  }

  // 常驻贴纸识图:每 3 分钟分析一小批 pending 常驻贴纸(分批避免打爆视觉额度;
  // 全部分析完后自动 no-op)。
  if (env().RESIDENT_STICKER_PACKS) {
    tasks.push(schedule('*/3 * * * *', () => {
      void safeRun('resident-sticker-analyze', async () => {
        const { analyzeResidentStickers } = await import('../knowledge/sticker/resident.js');
        await analyzeResidentStickers(6);
      });
    }));
  }

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

  // P5-A: Unified tick —— 决策合并的统一唤醒循环（常驻）。
  // 已取代 idle / proactive-scan / proactive-thinker / self-play / goal-check
  // 五个决策型 cron（它们的执行器保留在 tick 内部复用）。
  tasks.push(schedule(`*/${env().UNIFIED_TICK_INTERVAL_MIN} * * * *`, () => {
    void safeRun('unified-tick', async () => {
      const { runUnifiedTick } = await import('./unified-tick.js');
      await runUnifiedTick();
    });
  }));

  // Dream journal — multi cron (UTC, comma-separated); model WRITE/SKIP; append entries
  if (env().DREAM_JOURNAL_ENABLED) {
    const exprs = env()
      .DREAM_JOURNAL_CRON.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let any = false;
    for (const djCron of exprs) {
      if (!validate(djCron)) {
        logger.warn({ expr: djCron }, 'Invalid DREAM_JOURNAL_CRON entry, skipped');
        continue;
      }
      any = true;
      tasks.push(
        schedule(djCron, () => {
          void safeRun('dream-journal', async () => {
            const { runDreamJournal, inferDreamSlot } = await import('./dream-journal.js');
            await runDreamJournal({ slot: inferDreamSlot() });
          });
        }),
      );
    }
    if (any) logger.info({ crons: exprs }, 'Dream journal cron enabled');
  }

  // AGI Level 5 Phase 2: Dreaming 整合 — 每周日 04:17 低峰。
  if (env().DREAM_CONSOLIDATE_ENABLED) {
    tasks.push(
      schedule('17 4 * * 0', () => {
        void safeRun('dream-consolidate', async () => {
          const { runDreamConsolidate } = await import('./dream-consolidate.js');
          await runDreamConsolidate();
        });
      }),
    );
    logger.info('Dream consolidate cron enabled (Sun 04:17)');
  }

  // Silence alert — bot 沉默检测(端到端回复健康)。
  // 每 SILENCE_ALERT_INTERVAL_MIN 分钟扫一次「活跃但 bot 未回复」的 chat。
  // 默认关;开时配 SILENCE_ALERT_CHAT_ID 才真正发送,否则只打日志。
  if (env().SILENCE_ALERT_ENABLED) {
    const intervalMin = env().SILENCE_ALERT_INTERVAL_MIN;
    tasks.push(schedule(`*/${intervalMin} * * * *`, () => {
      void safeRun('silence-alert', async () => {
        const { runSilenceAlert } = await import('./silence-alert.js');
        await runSilenceAlert();
      });
    }));
    logger.info({ intervalMin }, 'Silence alert cron enabled');
  }

  // 借力其他 bot:周期观察学命令档案(P1,纯观察,flag 默认关)
  if (env().BOT_COMMAND_LEARN_ENABLED) {
    tasks.push(schedule(`*/${env().BOT_COMMAND_LEARN_INTERVAL_MIN} * * * *`, () => {
      void safeRun('bot-command-learn', async () => {
        const { runBotCommandLearn } = await import('./bot-command-scan.js');
        await runBotCommandLearn();
      });
    }));
  }

  // 口头禅自动惩罚闭环(盯自发言,复读超阈值→自动降权+动态拉黑,flag 默认关)
  if (env().TIC_PENALTY_ENABLED) {
    tasks.push(schedule(`*/${env().TIC_PENALTY_INTERVAL_MIN} * * * *`, () => {
      void safeRun('tic-penalty', async () => {
        const { runTicPenalty } = await import('./tic-penalty.js');
        await runTicPenalty();
      });
    }));
  }

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

  // （原 proactive-scan / proactive-thinker / self-play / goal-check 的独立
  // 注册已移除——决策统一由 unified-tick 做出，执行器在 tick 内部调用。）

  // P4-C: Self-reflect — 每 6h 复盘自己的回复表现（自我模型，加快学习循环）
  tasks.push(schedule('17 */6 * * *', () => {
    void safeRun('self-reflect', async () => {
      const { runSelfReflect } = await import('./self-reflect.js');
      await runSelfReflect();
    });
  }));

  // P2-B: RSS feed monitor — periodic feed polling + auto-post + fuel
  if (env().RSS_MONITOR_ENABLED) {
    tasks.push(schedule(`*/${env().RSS_MONITOR_INTERVAL_MIN} * * * *`, () => {
      void safeRun('rss-monitor', async () => {
        const { runRssMonitor } = await import('./rss-monitor.js');
        await runRssMonitor();
      });
    }));
  }

  // Topic scan — extract per-chat current topic + advance topic lifecycle (D1)
  if (env().TOPIC_REGISTRY_ENABLED) {
    tasks.push(schedule(`*/${env().TOPIC_SCAN_INTERVAL_MIN} * * * *`, () => {
      void safeRun('topic-scan', async () => {
        const { runTopicScan } = await import('./topic-scan.js');
        await runTopicScan();
      });
    }));
  }

  // Prompt-cache warmup — keep the static reply system prefix hot on DeepSeek
  if (env().CACHE_WARMUP_ENABLED) {
    tasks.push(schedule(`*/${env().CACHE_WARMUP_INTERVAL_MIN} * * * *`, () => {
      void safeRun('cache-warmup', async () => {
        const { runCacheWarmup } = await import('./cache-warmup.js');
        await runCacheWarmup();
      });
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
  // 命令学习可路由到 mundo(深推理,单次可达 480s);放宽到 12min 免慢调用撞死 tick。
  'bot-command-learn': 12 * 60_000,
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
  // 锁(_running)只在 fn() **真正 settle** 时释放,不在超时时释放(codex #2):
  // 原来超时后就删锁 → fn 仍在后台跑,下个 tick 会起同名任务并发(重复写库/发消息/
  // 烧 LLM)。现在超时只记告警,锁一直握到 fn 结束,下个 tick 因锁在被正常跳过。
  const task = fn().then(
    () => { logger.debug({ name, durationMs: Math.round(performance.now() - start) }, 'Cron job completed'); },
    (err) => { logger.error({ err, name, durationMs: Math.round(performance.now() - start) }, 'Cron job failed'); },
  ).finally(() => { _running.delete(name); });

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Cron job ${name} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    await Promise.race([task, timeout]);
  } catch {
    logger.warn(
      { name, timeoutMs },
      'Cron job exceeded timeout (仍在后台跑,锁保持到结束,不会并发起同名任务)',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
