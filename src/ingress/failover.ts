// ────────────────────────────────────────
// Ingress transport failover: polling ⇄ webhook
//
// Telegram allows only ONE ingress mode per bot (a registered webhook makes
// getUpdates return 409). So "webhook as a backup" = automatic failover:
// run long polling by default; if polling stops delivering, switch to webhook;
// after a recovery window, retry polling again.
//
// Design: restart-based. Each process boots into a single mode chosen from a
// Redis flag. The watchdog flips the flag and exits the process; systemd
// (Restart=always) brings it back up in the new mode. No in-process transport
// juggling — bulletproof and easy to reason about.
// ────────────────────────────────────────

import type { Bot } from 'grammy';
import type { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

type Redis = ReturnType<typeof getRedis>;

export type IngressMode = 'polling' | 'webhook';

const MODE_KEY = 'xxb:ingress:mode';
const LASTOK_KEY = 'xxb:poll:lastok';        // last successful getUpdates (ms)
const WEBHOOK_SINCE_KEY = 'xxb:ingress:webhook_since'; // when we switched to webhook (ms)

const WATCHDOG_INTERVAL_MS = 120_000; // check every 2 min
const STALL_MS = 300_000;             // polling considered dead after 5 min of no getUpdates
const BOOT_GRACE_MS = 300_000;        // don't fail over in the first 5 min of uptime
const RECOVERY_MS = 1_800_000;        // after 30 min on webhook, retry polling
const LASTOK_TTL_SEC = 1_200;         // heartbeat key TTL (20 min)

const log = logger.child({ mod: 'ingress-failover' });

/** Read the desired ingress mode (defaults to polling). */
export async function getIngressMode(redis: Redis): Promise<IngressMode> {
  try {
    return (await redis.get(MODE_KEY)) === 'webhook' ? 'webhook' : 'polling';
  } catch {
    return 'polling';
  }
}

async function setIngressMode(redis: Redis, mode: IngressMode): Promise<void> {
  await redis.set(MODE_KEY, mode);
}

/**
 * Install an API transformer that records a heartbeat on every successful
 * getUpdates call. This is the liveness signal for polling — it fires each
 * long-poll cycle (~every 30s or on update), only when the call succeeds.
 */
export function installPollHeartbeat(bot: Bot, redis: Redis): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method === 'getUpdates') {
      redis.set(LASTOK_KEY, String(Date.now()), 'EX', LASTOK_TTL_SEC).catch(() => {});
    }
    return res;
  });
}

/**
 * **启动看门狗**：进程起来了但没走到"能收消息"那一步就退出，让 systemd 重启。
 *
 * 2026-09-21 round 90 实测到这个盲区：机器外网断了，`createBot()` 里的
 * `getMe()` 永久挂起，进程卡在 "NyatDB opened (native)" 之后。
 * 而 `systemctl is-active` 报 **active**——systemd 只跟踪进程存亡，
 * 不知道它有没有启动完。于是：
 *   · 服务"活着"，实际零功能
 *   · 会话报告还在打印数据（卡住前的最后一口呼吸）
 *   · 人看到的是绿的
 *
 * 现有的 `startIngressWatchdog` 帮不上忙：它的 BOOT_GRACE_MS 是 300s，
 * 而它自己也是在 bot.start() 之后才装的——进程根本没走到那儿。
 *
 * 所以这里在最早的地方（createBot 之前）挂一个无条件计时器：
 * 超过 BOOT_STALL_MS 还没调 onReady 就 error + process.exit(1)。
 * systemd 会重启；真恢复不了的时候，它至少**响亮地失败**，
 * 而不是安静地装活。
 */
export function startBootWatchdog(onReady: () => void, stallMs = 120_000): void {
  let ready = false;
  onReady();
  const timer = setTimeout(() => {
    if (ready) return;
    logger.error(
      { uptimeSec: Math.round(process.uptime()), stallMs },
      'Boot watchdog: process never became ready — exiting so systemd restarts it',
    );
    // 给日志留出落盘时间再退
    setTimeout(() => process.exit(1), 250);
  }, stallMs);
  timer.unref();
  // 由调用方在真正就绪时调
  (globalThis as { __markBootReady?: () => void }).__markBootReady = () => {
    ready = true;
    clearTimeout(timer);
  };
}

/**
 * Start the failover watchdog. Runs on the bot-ingress owner only.
 * - polling mode: if no successful getUpdates for STALL_MS (after boot grace) → switch to webhook.
 * - webhook mode: after RECOVERY_MS → switch back to polling to retry the preferred transport.
 * Switching = flip the Redis flag and exit; systemd restarts into the new mode.
 */
export function startIngressWatchdog(redis: Redis, mode: IngressMode): void {
  let switching = false;

  const tick = async (): Promise<void> => {
    if (switching) return;
    try {
      if (mode === 'polling') {
        // Grace period after boot — polling needs time to establish.
        if (process.uptime() * 1000 < BOOT_GRACE_MS) return;
        const raw = await redis.get(LASTOK_KEY);
        const lastOk = raw ? parseInt(raw, 10) : 0;
        const age = Date.now() - lastOk;
        if (!lastOk || age > STALL_MS) {
          switching = true;
          log.error({ lastOkAgeMs: lastOk ? age : null }, 'Polling appears stalled — failing over to webhook');
          await setIngressMode(redis, 'webhook');
          await redis.set(WEBHOOK_SINCE_KEY, String(Date.now()));
          // systemd Restart=always will bring us back up in webhook mode.
          process.exit(0);
        }
      } else {
        // webhook mode — periodically retry the preferred polling transport
        const raw = await redis.get(WEBHOOK_SINCE_KEY);
        let since = raw ? parseInt(raw, 10) : 0;
        if (!since) {
          // key 缺失时必须落盘补一个起点 —— 否则每个 tick 都把 since 当
          // "现在",恢复倒计时永远归零,bot 永久卡在 webhook 模式。
          since = Date.now();
          await redis.set(WEBHOOK_SINCE_KEY, String(since)).catch(() => {});
        }
        if (Date.now() - since > RECOVERY_MS) {
          switching = true;
          log.info('Webhook recovery window elapsed — retrying polling');
          await setIngressMode(redis, 'polling');
          await redis.del(WEBHOOK_SINCE_KEY);
          process.exit(0);
        }
      }
    } catch (err) {
      log.warn({ err }, 'Ingress watchdog tick failed');
    }
  };

  const timer = setInterval(() => { void tick(); }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  log.info({ mode }, 'Ingress failover watchdog started');
}
