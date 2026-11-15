import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from './shared/logger.js';
import { env, getProviders } from './env.js';
import { registerOutboundSecrets } from './shared/outbound-privacy.js';
import { getConfig } from './shared/config.js';
import { getRedis, closeRedis } from './db/redis.js';
import { runMigrations, closeDb, getDb } from './db/sqlite.js';
import { createBot, stopBot, stopBotIngress } from './bot/bot.js';
import { startWorker, closeWorker } from './queue/worker.js';
import { startTaskWorker, closeTaskWorker } from './queue/task-worker.js';
import { closeQueue } from './queue/producer.js';
import { freeEncoder } from './ai/token-counter.js';
import { initSmartGroup } from './ai/smart-group.js';
import { createAllowlistMiddleware } from './bot/middleware/allowlist.js';
import { registerMemberHandler } from './bot/handlers/member.js';
import { registerMessageHandlers } from './bot/handlers/message.js';
import { registerFeedbackHandler } from './bot/handlers/feedback.js';
import { createAdminApi } from './admin/api.js';
import { createMonitorApi } from './admin/monitor.js';
import { startCronJobs, stopCronJobs, isStarted as isCronRunning } from './cron/scheduler.js';
import { initBotTracker } from './tracking/interaction.js';
import { isMemoryAvailable, warmEmbedder } from './memory/chroma.js';
import { callAllowlistReviewModel } from './allowlist/ai-call.js';
import { configFromEnv, defaultGetRecentContext } from './allowlist/bot-flow.js';
import type { AllowlistConfig } from './allowlist/types.js';
import { getStartupOwnership, ownsMetaLoop, assertIngressHttpOwnership } from './startup/ownership.js';
import { clearShutdownCheckpoint, writeShutdownCheckpoint } from './startup/shutdown-checkpoint.js';
import { closeHttpServer } from './startup/close-http.js';
import { StartupReadiness, registerReadinessRoute, registerReadinessLifecycle } from './startup/readiness.js';
import { getIngressMode, installPollHeartbeat, startIngressWatchdog } from './ingress/failover.js';
import {
  shouldRegisterBotCommands,
  shouldWarmMemory,
} from './startup/side-effects.js';
import { preloadSkills } from './pipeline/tools/registry.js';
import { startMetaLoop, stopMetaLoop, drainMetaLoop, isMetaLoopRunning } from './meta/index.js';
import { startCodeActWorker, closeCodeActWorker } from './subagent/index.js';
import { getSandboxCapability } from './sandbox/terminal.js';
import { assertMetaIsolationReady } from './startup/meta-isolation.js';
import { startOneBotRuntime, stopOneBotRuntime, pauseOneBotIngress, drainOneBotRecovery, getOneBotRuntimeStatus, validateOneBotConfig } from './platform/onebot-runtime.js';
import { durableTelegramMiddleware, IngressNotAcceptedError, startInboxRecovery } from './ingress/durable.js';
import type { Update } from 'grammy/types';
import { startQqHeartBatchRecovery } from './meta/qq-heart-batch.js';
import { processQqHeartBatch } from './meta/qq-heart-processor.js';
import type { NyatDbHandle } from './nyatdb/index.js';

import { installGlobalFetchProxy } from './shared/fetch-proxy.js';
import { startDynamicLogLevel } from './shared/logger.js';

/**
 * host-api 故意抛出的控制流错误——模型没 await 时会以 unhandledRejection 的形式
 * 冒到这里。它们不是 bug：发送预算用完 / 复读自己 / 传了非字符串 / 空文本。
 * 见 unhandledRejection handler 里的实测记录。
 */
const SANDBOX_CONTROL_FLOW_RE: RegExp[] = [
  /^sendText_limit:/,
  /^sendText_non_string:/,
  /^banned_word:/,
  /^empty text$/,
  /^echo_self_text/,
];

async function main(): Promise<void> {
  logger.info('xxb-ts starting…');

  // 1. Validate env
  const config = env();
  const processStartedAt = Date.now();
  clearShutdownCheckpoint(config.SQLITE_PATH);
  const ownership = getStartupOwnership();
  assertIngressHttpOwnership(ownership, config);
  registerOutboundSecrets(Array.from(getProviders().values(), (provider) => provider.apiKey));
  validateOneBotConfig(config);
  logger.info({ nodeEnv: config.NODE_ENV }, 'Environment validated');

  // A configured flag is not evidence that this service UID can create its
  // sandbox. Refuse to take over messages until the exact runtime passes.
  await assertMetaIsolationReady();
  if (config.META_SUBAGENT_ENABLED) logger.info('Meta isolation preflight passed');

  // 1.2 Global fetch proxy (KVM 受限网络：TG/LLM/Gemini 全走 xray 出口；本地直连）
  if (installGlobalFetchProxy(config.GLOBAL_FETCH_PROXY)) {
    logger.info('Global fetch proxy enabled (local addrs direct)');
  }

  // 1.3 round 85：动态日志级别开关（redis xxb:log:level，30s 内生效，不用重启）。
  // 必须在任何 logger.info 之前装，否则启动日志本身的级别是固定的。
  startDynamicLogLevel();

  // 1.5 Preload external skills
  void preloadSkills();

  // 2. Connect Redis
  const redis = getRedis();
  await redis.connect();
  let nyatDbForReadiness: NyatDbHandle | null = null;
  const readiness = config.READINESS_ENABLED ? new StartupReadiness({
    ownership, cronEnabled: config.CRON_ENABLED, metaEnabled: config.META_SUBAGENT_ENABLED,
    tasksEnabled: config.TASK_EXECUTOR_ENABLED, oneBotEnabled: config.ONEBOT_ENABLED,
    nyatDbEnabled: config.NYATDB_ENABLED,
    releaseId: config.NYAT_RELEASE_ID, pid: process.pid, processStartedAt,
  }, {
    redis,
    querySqlite: () => { getDb().prepare('SELECT name FROM _migrations LIMIT 1').get(); },
    queryNyatDb: () => {
      // Observe the boot-opened handle, never reopen storage from a health probe.
      if (!nyatDbForReadiness) throw new Error('nyatdb_not_open');
      nyatDbForReadiness.stats();
    },
    cronRunning: isCronRunning,
    metaRunning: isMetaLoopRunning,
    oneBotReady: () => getOneBotRuntimeStatus().state === 'ready',
  }) : undefined;

  // 3. Run SQLite migrations
  const appConfig = getConfig();
  runMigrations(appConfig.migrationsDir);

  // Autonomous tool execution is unavailable unless the configured isolation
  // capability is present. Keep the process alive for chat/health, but make the
  // safety state explicit before workers start.
  if (config.SANDBOX_ENABLED && config.SANDBOX_TERMINAL_ENABLED) {
    const capability = getSandboxCapability();
    if (capability.isolationRequired && !capability.bwrapAvailable) {
      // warn 不是 error：这是**静态环境条件**（这台机器没装 bwrap，apt 源里也没有
      // 这个包），不是某个本来能用的东西坏了。每次启动都报 error 的代价是
      // 205 条假警报把真故障淹掉——和 unhandledRejection 那 130 条同一个病。
      // 能力本身仍然是真的不可用（executeCommand 会拒绝），只是不该用 error 级。
      logger.warn(
        { capability },
        'Sandbox isolation unavailable; autonomous terminal execution is blocked ' +
          '(static: bwrap not installed — not a regression)',
      );
    } else {
      logger.info({ capability }, 'Sandbox capability verified');
    }
  }

  // 3.1 NyatDB (optional embedded engine; default off)
  try {
    const { getNyatDb } = await import('./nyatdb/index.js');
    nyatDbForReadiness = getNyatDb();
  } catch (err) {
    logger.warn({ err }, 'NyatDB open failed');
  }

  // 3.5 Initialize bot interaction tracker
  initBotTracker();

  // 3.9 启动看门狗：卡在启动中（实测：外网断 → getMe() 永久挂起）就响亮地退，
  // 让 systemd 重启，而不是 systemctl is-active 报 active 地装活。
  const { startBootWatchdog } = await import('./ingress/failover.js');
  startBootWatchdog(() => {});

  // 4. Create bot (fetches bot identity via getMe)
  const bot = await createBot();

  // 5. Build allowlist config from env
  const allowlistConfig: AllowlistConfig = configFromEnv(config);

  // 6. Register allowlist middleware
  if (allowlistConfig.enabled) {
    bot.use(createAllowlistMiddleware(allowlistConfig));
    logger.info('Allowlist middleware registered');
  }

  bot.use(durableTelegramMiddleware());

  // 7. Register member handler
  registerMemberHandler(bot, allowlistConfig);

  // 7.05 新人进群感知（真人环境：记入 missed 队列，bot 自己挑时机欢迎，不秒发机器人式欢迎语）
  {
    const { registerNewcomerHandler } = await import('./bot/handlers/newcomer.js');
    registerNewcomerHandler(bot);
  }

  // 7.1 Register join verification handler
  if (config.VERIFY_ENABLED) {
    const { registerJoinVerifyHandler } = await import('./bot/handlers/join-verify.js');
    registerJoinVerifyHandler(bot, {
      aiCall: callAllowlistReviewModel,
      masterUid: config.MASTER_UID,
    });
    logger.info('Join verification handler registered');
  }

  // 7.5 Register message handler (AFTER allowlist middleware so it takes effect)
  registerMessageHandlers(bot);

  registerFeedbackHandler();

  const stopTelegramRecovery = ownership.botIngress
    ? startInboxRecovery('telegram', entry => bot.handleUpdate(entry.payload as Update)) : () => {};
  if (ownership.botIngress) startQqHeartBatchRecovery(processQqHeartBatch, async () => {
    if (!env().META_SUBAGENT_ENABLED || !env().HEART_ENABLED || !env().META_HEART_ENABLED || getOneBotRuntimeStatus().state !== 'ready') return false;
    const { getSleepPhase } = await import('./tracking/sleep.js');
    return await getSleepPhase() === 'awake';
  });

  startOneBotRuntime(ownership.botIngress);

  // 8. Start BullMQ worker
  if (ownership.worker) {
    const messageWorker = startWorker();
    const taskWorker = startTaskWorker();
    readiness?.watchWorker('messages', messageWorker);
    readiness?.watchWorker('tasks', taskWorker);
    if (config.META_SUBAGENT_ENABLED) {
      const codeActWorker = startCodeActWorker();
      readiness?.watchWorker('codeact', codeActWorker);
    }
  } else {
    logger.info({ ownership }, 'Skipping worker startup in non-owner process');
  }

  // 9. Start bot ingress only on the elected owner.
  // Preferred transport is long polling (no inbound port needed); webhook is the
  // automatic failover target. The active mode is chosen from a Redis flag that
  // the failover watchdog flips when polling stalls / recovers.
  if (ownership.botIngress) {
    const ingressMode = await getIngressMode(redis);
    const canWebhook = !!(config.WEBHOOK_URL && config.WEBHOOK_SECRET);

    if (ingressMode === 'webhook' && canWebhook) {
      // ── Webhook mode (failover) ──
      const webhookUrl = `${config.WEBHOOK_URL}/webhook`;
      const secretToken = config.WEBHOOK_SECRET ?? undefined;
      try {
        await bot.api.setWebhook(webhookUrl, { secret_token: secretToken });
      } catch (err: unknown) {
        const retryAfter =
          err instanceof Error && 'parameters' in err
            ? ((err as Record<string, unknown>).parameters as Record<string, number> | undefined)?.retry_after
            : undefined;
        const delay = ((retryAfter ?? 1) + 1) * 1000;
        logger.warn({ delay }, 'setWebhook 429, retrying after delay');
        await new Promise((r) => setTimeout(r, delay));
        await bot.api.setWebhook(webhookUrl, { secret_token: secretToken });
      }
      logger.info({ url: config.WEBHOOK_URL }, 'Webhook set (failover mode)');
      readiness?.webhookRegistered();
      (globalThis as { __markBootReady?: () => void }).__markBootReady?.();
      startIngressWatchdog(redis, 'webhook');
      // Smart Group: 同 polling 分支,webhook 模式也恢复历史健康数据
      await initSmartGroup();
    } else {
      // ── Polling mode (preferred / default) ──
      if (ingressMode === 'webhook' && !canWebhook) {
        logger.warn('Ingress flag=webhook but WEBHOOK_URL/SECRET missing — falling back to polling');
      }
      // Clear any previously-registered webhook first, or getUpdates returns 409 Conflict.
      try {
        await bot.api.deleteWebhook();
        logger.info('Cleared webhook registration for polling mode');
      } catch (err) {
        logger.warn({ err }, 'deleteWebhook before polling failed (continuing)');
      }
      readiness?.usePolling();
      installPollHeartbeat(bot, redis, () => readiness?.pollSucceeded());
      // Smart Group: 从 Redis 恢复历史健康数据(重启不丢,auto-assign 首日就有据可依)。
      // 内部 SMART_GROUP_ENABLED=false 时 no-op。
      await initSmartGroup();
      // 清掉上一个进程留下的熔断账。
      //
      // round 87 实测：重启后前 5 分钟是全天最差的窗口——`all candidates skipped`
      // 194 次（稳定期 36 次的 5 倍）、`Circuit breaker tripped` 62 次（稳定期
      // 6 次的 10 倍）。原因不是零成功降权，是 `xxb:circuit:trip:*`（TTL 最长
      // 1800s）和 `xxb:circuit:fail:*`（TTL 86400s、只有成功才重置）**活在
      // Redis 里、跨重启不过期**——重启前被熔断的 label，重启后接着被熔断。
      //
      // 熔断器的语义是"这个 provider 此刻在失败，别锤它"。重启本身就是"此刻"
      // 的天然边界：新进程该从干净状态开始，真还在失败的几十秒内会重新熔断。
      try {
        const { CooldownTracker } = await import('./ai/cooldown.js');
        const cleared = await new CooldownTracker(redis).resetBreakerState();
        if (cleared > 0) logger.info({ cleared }, 'Cleared stale breaker state from previous process');
      } catch (err) {
        logger.debug({ err }, 'breaker state reset failed (non-critical)');
      }
      // round 63：进程内守卫的状态在这里清零，所以每次启动都留一句"为什么这值得记"。
      // 否则下一轮看到某条闸"拦 0 次"，又要花一轮才查出是没机会（round 41-44 花了两轮）。
      {
        const { logProcessBootContext } = await import('./cron/restart-hygiene.js');
        await logProcessBootContext();
      }
      // 不能 `void bot.start()`：409/401 会让 start() reject，轮询静默死掉、进程活着，
      // 5 分钟后看门狗才 exit —— 09-28→09-30 每 12 分钟重启一次就是这个（见 polling-recovery.ts）。
      const { startBotPollingWithRecovery } = await import('./ingress/polling-recovery.js');
      startBotPollingWithRecovery(bot, {
        onStart: () => {
          logger.info('Bot started (polling)');
          (globalThis as { __markBootReady?: () => void }).__markBootReady?.();
        },
        // message_reaction 默认不推送（grammY 文档），显式开——feedback 回流靠它收 reward。
        allowed_updates: [
          'message', 'edited_message', 'channel_post', 'edited_channel_post',
          'message_reaction', 'message_reaction_count',
          'callback_query', 'inline_query', 'my_chat_member', 'chat_member',
        ],
      });
      startIngressWatchdog(redis, 'polling', { webhookAvailable: canWebhook });
    }
  } else {
    logger.info({ ownership }, 'Skipping bot ingress startup in non-owner process');
  }

  // 9.5 Register bot commands menu only on the bot ingress owner
  if (shouldRegisterBotCommands(ownership)) {
    bot.api.setMyCommands([
      { command: 'checkin', description: '每日签到' },
      { command: 'stats', description: '群聊统计' },
      { command: 'watch', description: '盯一个话题的进展（仅私聊）' },
      { command: 'game', description: '小游戏 /game guess' },
      { command: 'muteme', description: '让bot不回复我' },
      { command: 'unmuteme', description: '恢复bot回复' },
      { command: 'cards', description: '我的猫娘图鉴（签到/活跃免费解锁）' },
      { command: 'wish', description: '心愿单 /wish add 卡名 · holders 找群友换卡' },
      { command: 'help', description: '帮助' },
    ]).catch((err) => logger.warn({ err }, 'Failed to set bot commands'));
  } else {
    logger.info({ ownership }, 'Skipping bot command registration in non-owner process');
  }

  // 10. Start Hono HTTP server (health check + admin API)
  // 持久化 token 记账(重启不清零;补 Prometheus 内存计数器之短)。无 flag,始终开。
  const { initTokenLedger } = await import('./metrics/token-ledger.js');
  initTokenLedger();
  // 社交决策记账(G8 A/B 基线)。同样无 flag、始终开 —— 基线要连续攒一周,
  // 一个默认关的观测开关等于没有观测。
  const { initSocialLedger } = await import('./metrics/social-ledger.js');
  initSocialLedger();

  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));
  registerReadinessRoute(app, readiness);
  // Prometheus metrics(借鉴 CGM:LLM token/缓存/延迟按用途可见)— flag-gated。
  if (config.METRICS_ENABLED) {
    const { initLlmMetrics } = await import('./metrics/llm-collector.js');
    initLlmMetrics();
    // round 73: 带口径头——裸 Prometheus 给机器读的，但这里主要读者是人。
    const { renderMetricsWithBanner } = await import('./metrics/registry.js');
    app.get('/metrics', (c) => c.text(renderMetricsWithBanner()));
    logger.info('Prometheus /metrics enabled');
  }
  // Mount admin API at /miniapp_api (kept: allowlist review console posts here;
  // the miniapp *frontend* is gone, allowlist ops moved to the bot DM flow)
  const adminApi = createAdminApi({
    redis,
    bot,
    config: allowlistConfig,
    env: config,
    aiCall: callAllowlistReviewModel,
    // 2026-08-20: without this the AI review can't fetch recent group messages,
    // producing waves of "no group data, suggest manual review".
    getRecentContext: defaultGetRecentContext,
  });
  app.route('/miniapp_api', adminApi);

  // Mount monitor API and static files
  const monitorApi = createMonitorApi({ redis, bot, env: config });
  app.route('/monitor/api', monitorApi);
  app.use('/monitor/*', serveStatic({ root: './' }));

  if (ownership.botIngress && config.WEBHOOK_URL && config.WEBHOOK_SECRET) {
    // Webhook endpoint for Telegram
    app.post('/webhook', async (c) => {
      const incoming = Buffer.from(c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '');
      const expected = Buffer.from(config.WEBHOOK_SECRET ?? '');
      if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
        return c.json({ ok: false }, 403);
      }
      try {
        const update = await c.req.json();
        await bot.handleUpdate(update);
      } catch (err) {
        // grammY wraps middleware exceptions in BotError.error. Only a failed
        // durable acceptance asks Telegram to redeliver; unknown started work
        // stays held locally and must not be replayed indefinitely by HTTP.
        const cause = err && typeof err === 'object' && 'error' in err ? err.error : err;
        if (cause instanceof IngressNotAcceptedError) return c.json({ ok: false, accepted: false }, 503);
        logger.error('Error handling webhook update');
      }
      return c.json({ ok: true });
    });
  }

  const server = ownership.http
    ? serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
      logger.info({ port: info.port }, 'HTTP server listening');
    })
    : null;

  if (!ownership.http) {
    logger.info({ ownership }, 'Skipping HTTP server startup in non-owner process');
  }

  // 12. Start cron jobs
  if (ownership.cron) {
    startCronJobs({ cleanupDeps: { redis, allowlistConfig } });

    // 12.0 常驻贴纸包 seed(幂等,fire-and-forget):把配置的主力贴纸包灌进库
    if (env().RESIDENT_STICKER_PACKS) {
      import('./knowledge/sticker/resident.js')
        .then(({ seedResidentPacks }) => seedResidentPacks())
        .then((n) => logger.info({ seeded: n }, 'Resident sticker packs seeded'))
        .catch((err) => logger.warn({ err }, 'Resident sticker seed failed (non-critical)'));
    }
  } else {
    logger.info({ ownership }, 'Skipping cron startup in non-owner process');
  }

  // 12.05 Meta+Subagent — Attention/callbacks Redis-backed.
  // Worker (or monolith) runs the loop; ingress-only only writes Redis.
  if (ownsMetaLoop(ownership)) {
    startMetaLoop();
  } else if (ownership.botIngress) {
    logger.info({ ownership }, 'Meta loop skipped on ingress-only (Redis Attention → worker)');
  }

  // 12.1 Warm up Qdrant + embedder (fire-and-forget) only on processes that use memory-dependent paths
  if (shouldWarmMemory(ownership)) {
    isMemoryAvailable().then((ok) => {
      logger.info({ ok }, 'Memory availability check');
    }).catch(() => { /* non-critical */ });
    // 这行注释原先写着 "Warm up ChromaDB + embedder",但函数体只 ping 了 Qdrant ——
    // getEmbedder() 从不在启动期被调用。补上真正的 embedder 预热。
    warmEmbedder();
  } else {
    logger.info({ ownership }, 'Skipping memory warmup in non-owner process');
  }

  // A worker/cron/HTTP process never enters the Telegram polling onStart callback.
  // Its successful startup must clear the same watchdog after its roles are wired.
  if (!ownership.botIngress) {
    (globalThis as { __markBootReady?: () => void }).__markBootReady?.();
    logger.info({ ownership }, 'Non-ingress roles initialized');
  }

  // 13. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down…');

    // Deployment sets TimeoutStopSec above this deadline. A timeout is a failed
    // shutdown and must never produce the checkpoint required by backups.
    const forceTimer = setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, 120_000);
    forceTimer.unref();

    // 分步日志:此前 'Shutting down…' 到 'Forced exit' 之间零日志,挂点
    // 无法归因(2026-07-04 诊断,restart 1 静默 30 秒)。
    const step = (name: string): void => logger.info({ step: name }, 'shutdown step');

    try {
      // 顺序契约(2026-07-04 重排):先断"新工作的来源"(cron/ingress),再掐
      // 在飞生成,最后才等 worker —— 旧顺序 closeWorker 在前,关机窗口内
      // 新消息持续打断→replan→起新 LLM 生成,30s 必然等不完。
      step('cron');
      pauseOneBotIngress();
      await stopTelegramRecovery();
      await drainOneBotRecovery();
      stopCronJobs();
      stopMetaLoop();
      // 关机广播先于 stopBot:中止全部在飞主回合生成(actor 收到 Shutdown
      // abort 后把锚点条目回 pending 供重启重放)—— TG 链路挂死时 stopBot
      // 可能拖延,不能让它推迟广播(review 加固 #1)。广播是同步的,窗口内
      // 新注册的生成拿到的是预中止信号。
      step('abort-generations');
      try {
        const { abortAllGenerations } = await import('./pipeline/turn/abort-registry.js');
        abortAllGenerations();
      } catch { /* non-critical */ }
      try {
        const { drainSelfContinuations } = await import('./pipeline/turn/self-continue.js');
        await drainSelfContinuations();
      } catch { /* non-critical */ }
      // grammY stop() 只中止 getUpdates 长轮询并保存 offset,bot.api 仍可用
      // —— 在飞 job 的 sendMessage 不受影响(旧注释"worker 先关,job 还要
      // 用 bot 发消息"的前提不成立)。窗口内到达的消息停在 TG 服务端队列,
      // 重启后原样送达。
      step('ingress');
      await stopBotIngress();
      step('http+buffers');
      await closeHttpServer(server);
      const { drainIngressTasks } = await import('./ingress/background.js');
      await drainIngressTasks();
      const { drainQqHeartBatches } = await import('./meta/qq-heart-batch.js');
      await drainQqHeartBatches();
      // Flush user-profile write buffers before closing DB
      try {
        const { _flushAllBuffers } = await import('./tracking/user-profile.js');
        _flushAllBuffers();
      } catch { /* non-critical */ }
      // 在飞 job 的 LLM fetch 已被 abort、deliver 睡眠挂了 shutdown 信号
      // → 秒级收尾,worker.close 不再无限期等。
      step('worker');
      const { drainHeartbeat } = await import('./cron/heartbeat.js');
      await drainHeartbeat();
      await drainMetaLoop();
      await closeTaskWorker();
      await closeCodeActWorker();
      await closeWorker();
      await stopBot();
      stopOneBotRuntime();
      step('queue');
      await closeQueue();
      // token 记账最后 flush 一次(别丢最后一分钟的账),需在 closeDb 之前。
      try { const { stopTokenLedger } = await import('./metrics/token-ledger.js'); stopTokenLedger(); } catch { /* non-critical */ }
      try { const { stopSocialLedger } = await import('./metrics/social-ledger.js'); stopSocialLedger(); } catch { /* non-critical */ }
      step('redis+db');
      await closeRedis();
      closeDb();
      const { closeNyatDb } = await import('./nyatdb/index.js');
      nyatDbForReadiness = null;
      closeNyatDb();
      freeEncoder();
      writeShutdownCheckpoint(config.SQLITE_PATH, processStartedAt);
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    process.exit(0);
  };

  process.on('unhandledRejection', (reason) => {
    // 沙盒 API 的**控制流拒绝**不是 bug，不该占着 error 级。
    //
    // 2026-09-21 实测：这两个 handler 一天刷 130 条 error，其中 86 条是
    // `sendText_limit:6`、44 条是 `echo_self_text`——全是 host-api **故意**抛的：
    // 发送预算用完、模型复读自己、文本不是字符串。模型在 CodeAct 里写了
    // `telegram.sendText(...)` 却没 await，这些拒绝就变成 unhandledRejection。
    //
    // 代价不是噪音本身，而是**狼来了**：error 级一天 130 条假警报，
    // 真故障会被训化成背景音。所以已知的控制流形状降到 info，其余保持 error。
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (SANDBOX_CONTROL_FLOW_RE.some((re) => re.test(msg))) {
      logger.info({ err: reason }, 'Unhandled rejection from sandbox control flow (expected)');
      return;
    }
    logger.error({ err: reason }, 'Unhandled promise rejection (non-fatal)');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception (non-fatal)');
  });

  registerReadinessLifecycle(readiness, shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
