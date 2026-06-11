import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { logger } from './shared/logger.js';
import { env } from './env.js';
import { getConfig } from './shared/config.js';
import { getRedis, closeRedis } from './db/redis.js';
import { runMigrations, closeDb } from './db/sqlite.js';
import { createBot, stopBot } from './bot/bot.js';
import { startWorker, closeWorker } from './queue/worker.js';
import { closeQueue } from './queue/producer.js';
import { freeEncoder } from './ai/token-counter.js';
import { createAllowlistMiddleware } from './bot/middleware/allowlist.js';
import { registerMemberHandler } from './bot/handlers/member.js';
import { registerMessageHandler } from './bot/handlers/message.js';
import { createAdminApi } from './admin/api.js';
import { createMonitorApi } from './admin/monitor.js';
import { startCronJobs, stopCronJobs } from './cron/scheduler.js';
import { initBotTracker } from './tracking/interaction.js';
import { isMemoryAvailable } from './memory/chroma.js';
import { callAllowlistReviewModel } from './allowlist/ai-call.js';
import type { AllowlistConfig } from './allowlist/types.js';
import { getStartupOwnership } from './startup/ownership.js';
import { getIngressMode, installPollHeartbeat, startIngressWatchdog } from './ingress/failover.js';
import {
  shouldRegisterBotCommands,
  shouldWarmMemory,
} from './startup/side-effects.js';
import { preloadSkills } from './pipeline/tools/registry.js';

async function main(): Promise<void> {
  logger.info('xxb-ts starting…');

  // 1. Validate env
  const config = env();
  logger.info({ nodeEnv: config.NODE_ENV }, 'Environment validated');

  // 1.5 Preload external skills
  void preloadSkills();

  // 2. Connect Redis
  const redis = getRedis();
  await redis.connect();

  // 3. Run SQLite migrations
  const appConfig = getConfig();
  runMigrations(appConfig.migrationsDir);

  // 3.5 Initialize bot interaction tracker
  initBotTracker();

  // 4. Create bot (fetches bot identity via getMe)
  const bot = await createBot();

  // 5. Build allowlist config from env
  const allowlistConfig: AllowlistConfig = {
    enabled: config.ALLOWLIST_ENABLED,
    redisPrefix: config.ALLOWLIST_REDIS_PREFIX,
    defaultEnabledAfterApproval: config.ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE,
    maxSubmissionsPerUserPerDay: config.ALLOWLIST_MAX_SUBMISSIONS_PER_DAY,
    autoAiReviewOnSubmit: config.ALLOWLIST_AUTO_AI_REVIEW,
    autoAiReviewMessageLimit: config.ALLOWLIST_AI_MESSAGE_LIMIT,
    aiReviewContextMaxChars: config.ALLOWLIST_AI_CONTEXT_MAX_CHARS,
    aiApproveAutoEnable: config.ALLOWLIST_AI_AUTO_ENABLE,
    aiApproveConfidenceThreshold: config.ALLOWLIST_AI_CONFIDENCE_THRESHOLD,
  };

  // 6. Register allowlist middleware
  if (allowlistConfig.enabled) {
    bot.use(createAllowlistMiddleware(allowlistConfig));
    logger.info('Allowlist middleware registered');
  }

  // 7. Register member handler
  registerMemberHandler(bot, allowlistConfig);

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
  registerMessageHandler(bot);

  const ownership = getStartupOwnership();

  // 8. Start BullMQ worker
  if (ownership.worker) {
    startWorker();
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
      startIngressWatchdog(redis, 'webhook');
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
      installPollHeartbeat(bot, redis);
      void bot.start({
        onStart: () => logger.info('Bot started (polling)'),
      });
      startIngressWatchdog(redis, 'polling');
    }
  } else {
    logger.info({ ownership }, 'Skipping bot ingress startup in non-owner process');
  }

  // 9.5 Register bot commands menu only on the bot ingress owner
  if (shouldRegisterBotCommands(ownership)) {
    bot.api.setMyCommands([
      { command: 'checkin', description: '每日签到' },
      { command: 'stats', description: '群聊统计' },
      { command: 'watch', description: '追踪话题 /watch 关键词' },
      { command: 'unwatch', description: '取消追踪 /unwatch 关键词' },
      { command: 'watches', description: '查看追踪列表' },
      { command: 'game', description: '小游戏 /game guess' },
      { command: 'muteme', description: '让bot不回复我' },
      { command: 'unmuteme', description: '恢复bot回复' },
      { command: 'feature', description: '群功能开关 /feature note off（群管）' },
      { command: 'setdefault', description: '设置私聊默认群 /setdefault' },
      { command: 'cards', description: '我的猫娘图鉴（签到/活跃免费解锁）' },
      { command: 'wish', description: '心愿单 /wish add 卡名 · holders 找群友换卡' },
      { command: 'help', description: '帮助' },
    ]).catch((err) => logger.warn({ err }, 'Failed to set bot commands'));
  } else {
    logger.info({ ownership }, 'Skipping bot command registration in non-owner process');
  }

  // 10. Start Hono HTTP server (health check + admin API)
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/miniapp', (c) => c.redirect('/miniapp/'));
  app.use('/miniapp/*', serveStatic({ root: './' }));

  // Mount admin API at /miniapp_api
  const adminApi = createAdminApi({
    redis,
    bot,
    config: allowlistConfig,
    env: config,
    aiCall: callAllowlistReviewModel,
  });
  app.route('/miniapp_api', adminApi);

  // Mount monitor API and static files
  const monitorApi = createMonitorApi({ redis, bot, env: config });
  app.route('/monitor/api', monitorApi);
  app.use('/monitor/*', serveStatic({ root: './' }));

  if (config.WEBHOOK_URL && config.WEBHOOK_SECRET) {
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
        logger.error({ err }, 'Error handling webhook update');
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
  } else {
    logger.info({ ownership }, 'Skipping cron startup in non-owner process');
  }

  // 12.1 Warm up ChromaDB + embedder (fire-and-forget) only on processes that use memory-dependent paths
  if (shouldWarmMemory(ownership)) {
    isMemoryAvailable().then((ok) => {
      logger.info({ ok }, 'Memory availability check');
    }).catch(() => { /* non-critical */ });
  } else {
    logger.info({ ownership }, 'Skipping memory warmup in non-owner process');
  }

  // 13. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down…');

    // Force exit after 30 seconds if graceful shutdown hangs
    const forceTimer = setTimeout(() => {
      logger.error('Forced exit after shutdown timeout');
      process.exit(1);
    }, 30_000);
    forceTimer.unref();

    try {
      server?.close();
      // Flush user-profile write buffers before closing DB
      try {
        const { _flushAllBuffers } = await import('./tracking/user-profile.js');
        _flushAllBuffers();
      } catch { /* non-critical */ }
      // (debounce 内存缓冲已拆除 —— P1 单一入口后 pending 在 Redis,重启无损)
      // 审计 #41:游离的自我接话不归 BullMQ 管 —— 先掐中止信号并排干,
      // 否则它们可能在 teardown 之后 sendMessage / 留下孤儿 chat 锁。
      // 信号掐下后,closeWorker 期间收尾的 job 再触发 maybeSelfContinue
      // 也会在入口直接 no-op。
      try {
        const { drainSelfContinuations } = await import('./pipeline/turn/self-continue.js');
        await drainSelfContinuations();
      } catch { /* non-critical */ }
      // Close worker FIRST — waits for in-progress jobs to finish
      // (they still need bot for sendMessage). Then stop bot.
      await closeWorker();
      await stopBot();
      await closeQueue();
      stopCronJobs();
      await closeRedis();
      closeDb();
      freeEncoder();
      logger.info('Shutdown complete');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
