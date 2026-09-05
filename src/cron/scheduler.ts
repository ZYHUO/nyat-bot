// ────────────────────────────────────────
// Scheduler — 全部任务注册到 tick 心跳系统(无 node-cron)
//
// 原 node-cron 调度已整体迁移到 heartbeat.ts 的任务注册表:
//   everySec(n)      ← '*/n * * * *'
//   dailyAt(h,m)     ← 'm h * * *'(北京时间)
//   weeklyAt(d,h,m)  ← 'm h * * d'(北京时间)
// unified-tick 不再有独立调度层,它只是注册表里的一个普通任务。
// ────────────────────────────────────────

import { env } from '../env.js';
import { runDailyReport } from './report.js';
import { runModelCheck } from './model-check.js';
import { runCleanup, type CleanupDeps } from './cleanup.js';
import { runKnowledgeSync } from './knowledge-sync.js';
import { runUserProfileSync } from '../tracking/user-profile.js';
// idle.ts / proactive-thinker.ts / self-play.ts / goal-check.ts / proactive-scan.ts
// 已被 unified-tick 取代并删除;活跃时段判断在 active-hours.ts。
import { runLearnerScan } from './learner-scan.js';
import { runChannelSync } from './channel-sync.js';
import { flushDailyStats } from '../tracking/stats.js';
import { logger } from '../shared/logger.js';
import { registerTickTask, startHeartbeat, stopHeartbeat, isStarted } from './heartbeat.js';

export interface CronDeps {
  cleanupDeps?: CleanupDeps;
}

let _started = false;
let _deps: CronDeps = {};

export function startCronJobs(deps?: CronDeps): void {
  if (_started) return;
  _started = true;
  if (deps) _deps = deps;

  if (!env().CRON_ENABLED) {
    logger.info('Cron jobs disabled via CRON_ENABLED');
    return;
  }

  const reg = registerTickTask;

  // Model status check — every 5 minutes
  reg({ name: 'model-check', everySec: 5 * 60, run: runModelCheck });

  // Daily report — every day at 23:55 Beijing time
  reg({ name: 'daily-report', dailyAt: { hour: 23, minute: 55 }, run: runDailyReport });

  // Cleanup — every 6 hours
  reg({
    name: 'cleanup',
    everySec: 6 * 3600,
    run: async () => { await runCleanup(_deps.cleanupDeps); },
  });

  // Verification timeout cleanup — every minute
  if (env().VERIFY_ENABLED) {
    reg({
      name: 'verify-cleanup',
      everySec: 60,
      run: async () => {
        const { cleanupTimedOutVerifications } = await import('../verification/cleanup.js');
        const { getBot } = await import('../bot/bot.js');
        const bot = getBot();
        if (bot) await cleanupTimedOutVerifications(bot);
      },
    });
  }

  // Behavioral role tagging — every 2h during active hours (8:00–22:00 CST-ish)
  // 原 cron '23 8-22/2 * * *' = 8/10/12/.../22 点的 23 分。间隔语义下取 2h,
  // 活跃时段过滤由任务内部逻辑承担(behavioral-roles 本身只在活跃群跑)。
  reg({
    name: 'behavioral-roles',
    everySec: 2 * 3600,
    run: async () => {
      const { runRoleAnalysis } = await import('../tracking/behavioral-roles.js');
      const n = await runRoleAnalysis();
      if (n > 0) logger.info({ chats: n }, 'Behavioral roles tick');
    },
  });

  // Feedback aggregate — hourly sentiment → self_model_notes
  reg({
    name: 'feedback-aggregate',
    everySec: 3600,
    run: async () => {
      const { runFeedbackAggregate } = await import('./feedback-aggregate.js');
      await runFeedbackAggregate();
    },
  });

  // Memory "dream" — nightly forgetting of old, never-recalled memories
  reg({
    name: 'memory-dream',
    dailyAt: { hour: 4, minute: 41 },
    run: async () => {
      const { runMemoryDream } = await import('./memory-dream.js');
      const forgotten = await runMemoryDream();
      if (forgotten > 0) logger.info({ forgotten }, 'Memory dream tick');
    },
  });

  // #8 关系叙事 — 每天给互动多的群友写/更新一句 "你和TA" 的共同经历概括
  reg({
    name: 'relationship-summarize',
    dailyAt: { hour: 5, minute: 19 },
    run: async () => {
      const { runRelationshipSummarize } = await import('./relationship-summarize.js');
      await runRelationshipSummarize();
    },
  });

  // token 记账日报 — 每天把昨天/今天各 provider 的 token 消耗打进 info 日志
  reg({
    name: 'token-report',
    dailyAt: { hour: 0, minute: 3 },
    run: async () => {
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
    },
  });

  // 机制5:LLM 全局画像合并(每 2 小时,配 PROFILE_MERGE_STALE_HOURS 水位线)
  if (env().PROFILE_MERGE_ENABLED) {
    reg({
      name: 'profile-merge',
      everySec: 2 * 3600,
      run: async () => {
        const { runProfileMerge } = await import('./profile-merge.js');
        await runProfileMerge();
      },
    });
  }

  // 深度反思(A)—— 对活跃群提炼"本群近况"注入回复;吞吐可调(REFLECTION_*)
  if (env().REFLECTION_ENABLED) {
    reg({
      name: 'deep-reflection',
      everySec: env().REFLECTION_INTERVAL_MIN * 60,
      run: async () => {
        const { runDeepReflection } = await import('./deep-reflection.js');
        await runDeepReflection();
      },
    });
  }

  // StepFun 配额消费引擎(滚动深反思)—— 每分钟拉一批全池工作项并发跑
  if (env().STEPFUN_CONSUMER_ENABLED) {
    reg({
      name: 'stepfun-consumer',
      everySec: 60,
      run: async () => {
        const { runStepfunConsumer } = await import('./stepfun-consumer.js');
        await runStepfunConsumer();
      },
    });
  }

  // AGI L6 Phase 13.4: 任务唤醒 —— 到点(next_wake)的任务派发执行。
  if (env().TASK_EXECUTOR_ENABLED) {
    reg({
      name: 'task-wake',
      everySec: 60,
      run: async () => {
        const { wakeDueTasks } = await import('./task-wake.js');
        await wakeDueTasks();
      },
    });
  }

  // AGI L6 Phase 14: 连接率计算 —— 回填已到 5 分钟窗口的连接率。
  if (env().CONNECTIVITY_TRACKING_ENABLED) {
    reg({
      name: 'connectivity-calc',
      everySec: 2 * 60,
      run: async () => {
        const { calculateConnectivityWindows } = await import('../agent/reverse-valve.js');
        const n = await calculateConnectivityWindows();
        if (n > 0) logger.info({ windows: n }, 'connectivity windows calculated');
      },
    });
  }

  // 功能 A3:每日「今日感想」生成(每小时跑,内部按 BJ 日去重,只生成一次)。
  if (env().SCHOOL_SCHEDULE_ENABLED) {
    reg({
      name: 'school-day-plan',
      everySec: 3600,
      run: async () => {
        const { runSchoolDayPlan } = await import('./school-day-plan.js');
        await runSchoolDayPlan();
      },
    });
  }

  // 常驻贴纸识图:每 3 分钟分析一小批 pending 常驻贴纸
  if (env().RESIDENT_STICKER_PACKS) {
    reg({
      name: 'resident-sticker-analyze',
      everySec: 3 * 60,
      run: async () => {
        const { analyzeResidentStickers } = await import('../knowledge/sticker/resident.js');
        await analyzeResidentStickers(6);
      },
    });
  }

  // G7(语言生命)群共同经历 — 每 2 小时为活跃群提炼 0-2 条"群里发生的事"
  reg({
    name: 'group-episodes',
    everySec: 2 * 3600,
    run: async () => {
      const { getRedis } = await import('../db/redis.js');
      const { summarizeEpisodes } = await import('../tracking/group-episodes.js');
      const raw = await getRedis().zrange('xxb:active_groups', -6, -1);
      for (const idStr of raw) {
        const chatId = Number(idStr);
        if (chatId < 0) await summarizeEpisodes(chatId).catch(() => {});
      }
    },
  });

  // Expression learning gate — hourly auto-review of pending learned patterns
  reg({
    name: 'expression-gate',
    everySec: 3600,
    run: async () => {
      const { runExpressionGate } = await import('../learners/expression-gate.js');
      const n = await runExpressionGate();
      if (n > 0) logger.info({ reviewed: n }, 'Expression gate tick');
    },
  });

  // Knowledge base sync — configurable; only runs when chat IDs set
  // 原 KNOWLEDGE_CRON_SCHEDULE 是 cron 表达式,迁移后按其分钟数取间隔。
  const ksMin = parseCronToMinutes(env().KNOWLEDGE_CRON_SCHEDULE);
  if (ksMin !== null) {
    reg({
      name: 'knowledge-sync',
      everySec: ksMin * 60,
      run: runKnowledgeSync,
    });
  } else {
    logger.warn({ expr: env().KNOWLEDGE_CRON_SCHEDULE }, 'Invalid KNOWLEDGE_CRON_SCHEDULE, knowledge-sync disabled');
  }

  // User profile sync — every hour, Qwen3.6+ summarizes pending messages per user
  reg({ name: 'user-profile-sync', everySec: 3600, run: runUserProfileSync });

  // P5-A: Unified tick —— 决策合并的统一唤醒循环(常驻)。
  // 已取代 idle / proactive-scan / proactive-thinker / self-play / goal-check
  // 五个决策型 cron(它们的执行器保留在 tick 内部复用)。
  // 迁移到心跳后:它只是注册表里的一个普通间隔任务,不再有独立调度层。
  reg({
    name: 'unified-tick',
    everySec: env().UNIFIED_TICK_INTERVAL_MIN * 60,
    run: async () => {
      const { runUnifiedTick } = await import('./unified-tick.js');
      await runUnifiedTick();
    },
  });

  // Dream journal — multi slot (北京时间,逗号分隔); model WRITE/SKIP; append entries
  if (env().DREAM_JOURNAL_ENABLED) {
    const slots = env()
      .DREAM_JOURNAL_CRON.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let any = false;
    for (const djCron of slots) {
      const at = parseCronToDaily(djCron);
      if (!at) {
        logger.warn({ expr: djCron }, 'Invalid DREAM_JOURNAL_CRON entry, skipped');
        continue;
      }
      any = true;
      reg({
        name: `dream-journal:${at.hour}:${at.minute}`,
        dailyAt: at,
        run: async () => {
          const { runDreamJournal, inferDreamSlot } = await import('./dream-journal.js');
          await runDreamJournal({ slot: inferDreamSlot() });
        },
      });
    }
    if (any) logger.info({ slots }, 'Dream journal slots enabled');
  }

  // Dreaming 自由时段(CGM background-agent 简化版):凌晨派发特权长 CodeAct 任务。
  if (env().DREAMING_ENABLED) {
    const at = parseCronToDaily(env().DREAMING_CRON);
    if (at) {
      reg({
        name: 'dreaming',
        dailyAt: at,
        run: async () => {
          const { runDreaming } = await import('./dreaming.js');
          await runDreaming();
        },
      });
      logger.info({ at }, 'Dreaming task enabled');
    } else {
      logger.warn({ expr: env().DREAMING_CRON }, 'Invalid DREAMING_CRON, dreaming disabled');
    }
  }

  // AGI Level 5 Phase 2: Dreaming 整合 — 每周日 04:17 低峰。
  if (env().DREAM_CONSOLIDATE_ENABLED) {
    reg({
      name: 'dream-consolidate',
      weeklyAt: { day: 0, hour: 4, minute: 17 },
      run: async () => {
        const { runDreamConsolidate } = await import('./dream-consolidate.js');
        await runDreamConsolidate();
      },
    });
    logger.info('Dream consolidate task enabled (Sun 04:17)');
  }

  // Silence alert — bot 沉默检测(端到端回复健康)。
  if (env().SILENCE_ALERT_ENABLED) {
    reg({
      name: 'silence-alert',
      everySec: env().SILENCE_ALERT_INTERVAL_MIN * 60,
      run: async () => {
        const { runSilenceAlert } = await import('./silence-alert.js');
        await runSilenceAlert();
      },
    });
    logger.info({ intervalMin: env().SILENCE_ALERT_INTERVAL_MIN }, 'Silence alert task enabled');
  }

  // 借力其他 bot:周期观察学命令档案(P1,纯观察)
  if (env().BOT_COMMAND_LEARN_ENABLED) {
    reg({
      name: 'bot-command-learn',
      everySec: env().BOT_COMMAND_LEARN_INTERVAL_MIN * 60,
      run: async () => {
        const { runBotCommandLearn } = await import('./bot-command-scan.js');
        await runBotCommandLearn();
      },
    });
  }

  // 口头禅自动惩罚闭环(盯自发言,复读超阈值→自动降权+动态拉黑)
  if (env().TIC_PENALTY_ENABLED) {
    reg({
      name: 'tic-penalty',
      everySec: env().TIC_PENALTY_INTERVAL_MIN * 60,
      run: async () => {
        const { runTicPenalty } = await import('./tic-penalty.js');
        await runTicPenalty();
      },
    });
  }

  // 硬作息心跳(v2):动态就寝 shift、晚安/早安边沿、半夜醒、补回排水
  if (env().SLEEP_SCHEDULE_ENABLED) {
    reg({
      name: 'sleep-cycle',
      everySec: 60,
      run: async () => {
        const { runSleepCycle } = await import('./sleep-cycle.js');
        await runSleepCycle();
      },
    });
  }

  // （原 proactive-scan / proactive-thinker / self-play / goal-check 的独立
  // 注册已移除——决策统一由 unified-tick 做出，执行器在 tick 内部调用。）

  // P4-C: Self-reflect — 每 6h 复盘自己的回复表现(自我模型,加快学习循环)
  reg({
    name: 'self-reflect',
    everySec: 6 * 3600,
    run: async () => {
      const { runSelfReflect } = await import('./self-reflect.js');
      await runSelfReflect();
    },
  });

  // 自我技能沉淀: 每 6h 蒸馏小 skill
  if (env().SKILL_DISTILL_ENABLED) {
    reg({
      name: 'skill-distill',
      everySec: env().SKILL_DISTILL_INTERVAL_MIN * 60,
      run: async () => {
        const { runSkillDistill } = await import('./skill-distill.js');
        await runSkillDistill();
      },
    });
  }

  // 自我技能沉淀: 每周合并小 skill → 大 skill,归档防爆
  if (env().SKILL_CONSOLIDATE_ENABLED) {
    reg({
      name: 'skill-consolidate',
      weeklyAt: { day: 0, hour: 4, minute: 23 },
      run: async () => {
        const { runSkillConsolidate } = await import('./skill-consolidate.js');
        await runSkillConsolidate();
      },
    });
  }

  // 爱好蒸馏: 每天一次从群友爱好蒸馏 bot 自己的爱好(慢变量)
  if (env().HOBBY_DISTILL_ENABLED) {
    reg({
      name: 'hobby-distill',
      dailyAt: { hour: 5, minute: 41 },
      run: async () => {
        const { distillHobbies } = await import('../tracking/hobbies.js');
        await distillHobbies();
      },
    });
  }

  // P2-B: RSS feed monitor — periodic feed polling + auto-post + fuel
  if (env().RSS_MONITOR_ENABLED) {
    reg({
      name: 'rss-monitor',
      everySec: env().RSS_MONITOR_INTERVAL_MIN * 60,
      run: async () => {
        const { runRssMonitor } = await import('./rss-monitor.js');
        await runRssMonitor();
      },
    });
  }

  // Topic scan — extract per-chat current topic + advance topic lifecycle (D1)
  if (env().TOPIC_REGISTRY_ENABLED) {
    reg({
      name: 'topic-scan',
      everySec: env().TOPIC_SCAN_INTERVAL_MIN * 60,
      run: async () => {
        const { runTopicScan } = await import('./topic-scan.js');
        await runTopicScan();
      },
    });
  }

  // Prompt-cache warmup — keep the static reply system prefix hot on DeepSeek
  if (env().CACHE_WARMUP_ENABLED) {
    reg({
      name: 'cache-warmup',
      everySec: env().CACHE_WARMUP_INTERVAL_MIN * 60,
      run: async () => {
        const { runCacheWarmup } = await import('./cache-warmup.js');
        await runCacheWarmup();
      },
    });
  }

  // Learner scan — expression + jargon extraction (Stage D)
  if (env().LEARNER_ENABLED) {
    reg({
      name: 'learner-scan',
      everySec: env().LEARNER_SCAN_INTERVAL_MIN * 60,
      run: runLearnerScan,
    });
  }

  // Channel source scraping — every 30 minutes, fetch public channel posts into ChromaDB
  reg({ name: 'channel-sync', everySec: 30 * 60, run: runChannelSync });

  // Daily stats flush — every hour
  reg({
    name: 'stats-flush',
    everySec: 3600,
    run: async () => { flushDailyStats(); },
  });

  startHeartbeat();
}

export function stopCronJobs(): void {
  stopHeartbeat();
  _started = false;
  logger.info('Cron jobs stopped');
}

export { isStarted };

// ── cron 表达式兼容解析(迁移期 .env 里还是 cron 写法) ────────────────────

/** 把简单 cron 表达式解析成「每天 h:m」;解析不了返回 null。 */
function parseCronToDaily(expr: string): { hour: number; minute: number } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  if (!/^\d+$/.test(min!) || !/^\d+$/.test(hour!)) return null;
  const m = Number(min);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return { hour: h, minute: m };
}

/** 把简单 cron 表达式解析成间隔分钟数;解析不了返回 null。 */
function parseCronToMinutes(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (hour !== '*' || dom !== '*' || mon !== '*' || dow !== '*') return null;
  const step = /^\*\/(\d+)$/.exec(min!);
  if (step) {
    const n = Number(step[1]);
    return n > 0 ? n : null;
  }
  if (min === '*') return 1; // 每分钟
  if (/^\d+$/.test(min!)) return 60; // 固定分钟(如 '30 * * * *')= 每小时
  return null;
}
