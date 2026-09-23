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
// round 85: 进程忩命量纸——把“重启很频”变成可见的行。
// round 84 把它列为“待排期”而且斩此会脚应喝的是调度的代价（一个告警）；
// round 85 发现它其实不费——差的只是轮次号，所以当轮做。
import { reportProcessLifetime, sweepStaleAgentTasks } from './restart-hygiene.js';
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
  // round 85：进程忩命量纸（每小时一行，不存状态不告警）
  reg({ name: 'process-lifetime', everySec: 3600, run: async () => { reportProcessLifetime(); } });
  // round 105: **残留活动任务索引的自慈摧拦**——round 102-104 那个 5 小时的死任任务。
  // 放在同一个 1h tick 上（残留不急），不额外开一个调度。
  reg({ name: 'stale-agent-sweep', everySec: 3600, run: async () => { await sweepStaleAgentTasks(); } });

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

  // Debt sweep — 认知债务过期/到期扫描 + 预测误差摘要（CSR，默认关）
  if (env().DEBT_SWEEP_ENABLED) {
    reg({
      name: 'debt-sweep',
      everySec: env().DEBT_SWEEP_INTERVAL_MIN * 60,
      run: async () => {
        const { runDebtSweep } = await import('./debt-sweep.js');
        await runDebtSweep();
      },
    });
  }

  // Durable cognitive projection — explicitly gated so event logging can be
  // enabled independently of debt creation or any Agency authority.
  if (env().COGNITIVE_OUTBOX_ENABLED === true) {
    reg({
      name: 'cognitive-outbox',
      everySec: 15,
      run: async () => {
        const { drainCognitiveOutbox } = await import('../agent/cognitive-outbox-worker.js');
        const { projectCognitiveOutboxItem } = await import('../agent/cognitive-projector.js');
        const result = await drainCognitiveOutbox(
          async (item) => {
            await projectCognitiveOutboxItem(item, { createDebts: env().DEBT_AUTO_MATCH_ENABLED === true });
          },
          { workerId: `cron:cognitive:${process.pid}`, batchSize: 50, leaseSec: 90, maxAttempts: 5 },
        );
        if (result.claimed > 0) logger.info({ result }, 'cognitive outbox projection tick');
      },
    });
  }

  // Belief verification — consumes the `stale_belief` debts the outbox above
  // creates. Without it those debts accumulated unread (20 open, measured
  // 2026-09-19) and beliefs the world had invalidated stayed in the prompt.
  // Slow on purpose: beliefs do not go stale by the minute.
  if (env().BELIEF_VERIFY_ENABLED === true) {
    reg({
      name: 'belief-verify',
      everySec: 1800,
      run: async () => {
        const { verifyStaleBeliefs } = await import('../agent/belief-verify.js');
        verifyStaleBeliefs();
      },
    });
  }

  // Nyat Trench · L0 时间泵。
  //
  // 论文 §3.2：海床积分器的唯一衰减方。气压 P 若只增不减，r=clamp(θ·g(P)) 会
  // 永久钉在上界——那正是 satiation latch 事故的形状（时钟被绕 → 永久饱和 →
  // 4 天 0 主动发言无人知）。泵每 PUMP_HALFLIFE_SEC 内部去重，所以这里每 30 分钟
  // 调一次是安全的 guard，不是额外衰减。
  //
  // 零 token、零 LLM：一次 Redis 读 + 一次写 + 一条 JSONL。
  if (env().TRENCH_PUMP_ENABLED === true) {
    reg({
      name: 'trench-pump',
      everySec: 1800,
      run: async () => {
        const { pump } = await import('../nyatos/trench.js');
        // 同一份活跃群集合（unified-tick 的 discoverGroups 是私有的，不新导公共接口）
        const { getRedis } = await import('../db/redis.js');
        const raw = await getRedis().zrange('xxb:active_groups', 0, 19);
        let pumped = 0;
        let stuckReset = 0;
        for (const id of raw.map(Number).filter((n) => Number.isSafeInteger(n) && n < 0)) {
          // 卡死自恢复：P 连续顶在 P_MAX 若干小时 → 硬复位。
          //
          // **在泵浦之前查**（round 84 加）。曾经 pump() 先跑再查，于是泵浦减半的
          // 那些 tick 上 recoverIfStuck 会读到减半后的值而漏判。但注意 round 101 的
          // 实证修正：**它不是"结构上不可达"**——cron 30 分钟一次而半衰期 60 分钟，
          // 约每隔一个 tick 泵浦不减半，那些 tick 上旧顺序照样检测得到。
          // 真实缺陷是"最多延迟一个 tick（30 分钟）"，对 6 小时阈值是 8% 延迟。
          // 提前查让它变成即时检测，不是从不可用变成可用。
          //
          // 策略在 trench.ts 的 recoverIfStuck() 里（可测），cron 只负责调用。
          try {
            const { recoverIfStuck } = await import('../nyatos/trench.js');
            if (await recoverIfStuck(id)) stuckReset += 1;
          } catch { /* per-chat fail-soft */ }
          try {
            if (await pump(id)) pumped += 1;
          } catch { /* per-chat fail-soft */ }
        }
        // 压力轨迹：每次泵浦记录相位 + P 最高的几个群。
        //
        // **这段曾经被我自己吃掉**：round 48 加进来，后来某次编辑把整块替换掉了，
        // 而日志里那 3 条 pump tick 全是旧进程的（20:03/20:33/21:03），当前进程
        // 一条都没有。我据那些陈旧日志判断过"P 全零 = 睡眠积压没生效"——
        // 那是一次拿旧进程的显示当现状的诊断。
        //
        // **按 P 降序取前 5，不是取 active_groups 的前 5 个**：zrange 头部的群恰好
        // P=0（实测 6 个群有气压，而日志里 5 个全是 0），不排序的话轨迹是一条假零线。
        try {
          const { readTrench } = await import('../nyatos/trench.js');
          const { getLifeState } = await import('../tracking/life-state.js');
          const phase = getLifeState().state;
          const allIds = raw.map(Number).filter((n) => Number.isSafeInteger(n) && n < 0);
          const top = (await Promise.all(
            allIds.map(async (id) => ({ id, p: (await readTrench(id)).p })),
          ))
            .sort((a, b) => b.p - a.p)
            .slice(0, 5);
          logger.info({ phase, pumped, stuckReset, top }, 'trench pump tick: phase + top pressures');
        } catch { /* 观测失败不影响泵浦 */ }
        if (pumped > 0) logger.debug({ pumped }, 'trench pump: halved pressure');
        if (stuckReset > 0) logger.warn({ stuckReset }, 'trench: pressure stuck at P_MAX for 6h — hard reset');
      },
    });
  }

  // Nyat Trench · 醒来检测（独立 2 分钟快 tick）。
  //
  // **为什么必须独立**：时间泵每 30 分钟一次且先减半 P。若复用它，0:14 醒来要等
  // 0:34 才记录，P 已被减半两次，记录值只剩实际醒来值的四分之一——那会让
  // "睡眠积压"这个特性看起来完全没生效。
  //
  // **为什么差点又没有**：这功能在 round 48 加进泵浦 cron，round 49 我抽取
  // recoverIfStuck 时把整块内联检测一起吃掉了，而没有任何东西报警——
  // 它没有一个测试在跑。round 71 才发现。现在的守护是 tests/unit/nyatos/
  // trench-exports.test.ts（导出必须有 src 调用方）。
  if (env().TRENCH_PUMP_ENABLED === true) {
    reg({
      name: 'trench-wake-detect',
      everySec: 120,
      run: async () => {
        const { detectWakeTransition } = await import('../nyatos/trench.js');
        const { getRedis } = await import('../db/redis.js');
        const raw = await getRedis().zrange('xxb:active_groups', 0, 19);
        const ids = raw.map(Number).filter((n) => Number.isSafeInteger(n) && n < 0);
        const woke = await detectWakeTransition(ids);
        logger.info({ woke, active: ids.length }, 'trench cron: wake-detect ran');
      },
    });
  }

  // Nyat Trench · L2 反射：Echo 回填 + E 更新 + P 脉冲。  // Nyat Trench · L2 反射：Echo 回填 + E 更新 + P 脉冲。
  //
  // 修的是一个纯写入侧缺漏：主动发言（trigger_uid=0）从不进 outcome.ts 的
  // pending 队列，所以那条闭合管道对它从未生效——实测 self_replies 3,337 行里
  // 98.7% 永远是 unknown。本任务用 bot_interactions 做一次纯 SQL 回扫。
  // 零 LLM、零 token。
  if (env().ECHO_ENABLED === true) {
    reg({
      name: 'echo-backfill',
      everySec: 1800,
      run: async () => {
        const { backfillEcho } = await import('../agent/echo.js');
        const n = await backfillEcho();
        // 无条件心跳：backfillEcho 只在 settled>0 时自己打日志，于是"在跑但结算 0 条"
        // 和"没在跑"在日志里完全无法区分。2026-09-19 我就因此分不清——
        // echo: backfilled 一次都没出现过，而我无法判断这是不是又一个静默死亡。
        logger.info({ settled: n }, 'trench cron: echo-backfill ran');
      },
    });

  // 同时段对照基线采集（Phase 1 的归判前提）。每天 12:30 UTC = 20:30 北京拍一张
  // 各群发送率快照，落 var/control-baseline.jsonl。**纯只读**：不翻开关、不改行为，
  // 所以可以一直跑；论文 §九·补七 算出候选群同期 σ=19%，单日读数不可归因，
  // 需要 ~5 天/组，这个 cron 就是让基线自己长出来而不用谁记得。
  if (env().CONTROL_BASELINE_ENABLED !== false) {
    reg({
      name: 'control-baseline',
      dailyAt: { hour: 12, minute: 30 },
      run: async () => {
        const { execSync } = await import('node:child_process');
        execSync('npx tsx scripts/control-baseline.mts record', {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 120_000,
        });
        logger.info({}, 'trench cron: control-baseline recorded');
      },
    });
  }
  }

  // Event-backed mission/process continuity. This tick only claims due wake
  // records and schedules durable process work; it never calls a model, tool,
  // or Telegram adapter by itself.
  if (env().COGNITIVE_CONTINUITY_ENABLED === true) {
    reg({
      name: 'cognitive-continuity',
      everySec: env().COGNITIVE_CONTINUITY_INTERVAL_SEC,
      run: async () => {
        const { runCognitiveContinuityTick } = await import('../agent/cognitive-continuity.js');
        const result = runCognitiveContinuityTick();
        let processResult: Record<string, number> | undefined;
        if (env().COGNITIVE_PROCESS_RUNTIME_ENABLED === true) {
          const { runCognitiveProcessTick } = await import('../agent/cognitive-process-runtime.js');
          processResult = { ...await runCognitiveProcessTick() };
        }
        if (result.missionsWoken > 0 || result.processesWoken > 0 || (processResult?.claimed ?? 0) > 0) {
          logger.info({ ...result, processResult }, 'cognitive continuity wake tick');
        }
      },
    });
  }

  // Kernel crash recovery. A turn that reached `dispatched` and then lost its
  // process has no terminal outcome; this tick closes only the actions whose
  // host budget has expired, as `interrupted`, and never re-sends anything.
  if (env().COGNITIVE_KERNEL_RECOVERY_ENABLED === true) {
    reg({
      name: 'cognitive-kernel-recovery',
      everySec: 60,
      run: async () => {
        const { recoverStaleKernelActions } = await import('../agent/cognitive-recovery.js');
        recoverStaleKernelActions();
      },
    });
  }

  // Social prediction expiry is a metadata-only projection. Keep it separate
  // from debt auto-repayment so silence outcomes settle even when debt sweeps
  // remain disabled; the helper is fail-soft when migration 0103 is absent.
  if (env().SOCIAL_PREDICTION_ENABLED === true) {
    reg({
      name: 'social-prediction-sweep',
      everySec: 15 * 60,
      run: async () => {
        const { expireSocialPredictions } = await import('../agent/social-predictions.js');
        const expired = expireSocialPredictions({ limit: 500 });
        if (expired > 0) logger.info({ expired }, 'social prediction silence outcomes settled');
      },
    });
  }

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

  // Phase 14.4: 谄媚审计 — 每周跑一次(周日凌晨错峰),离线抽样五维打分落库。
  // flag 关时不注册,零开销。只记录不干预;趋势进 self-reflect 证据。
  if (env().SYCOPHANCY_AUDIT_ENABLED) {
    reg({
      name: 'sycophancy-audit',
      everySec: 7 * 24 * 3600,
      run: async () => {
        const { runSycophancyAudit } = await import('./sycophancy-audit.js');
        await runSycophancyAudit();
      },
    });
  }

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
