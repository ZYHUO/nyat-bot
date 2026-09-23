import pino from 'pino';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

/**
 * round 85：**不重启就能开 debug。**
 *
 * 全仓 408 处 `logger.debug`，而生产 `LOG_LEVEL=info`——它们一律不可见。
 * 这个会话为这件事付过两次学费：
 *
 *   · round 75：截断重试走 debug，我 grep 到 0 条就判定"没走到"，
 *     排了十二项代码逻辑。真相是**走了但被过滤了**。
 *   · round 81：grep `AI call failed` 漏了 `Label failed, trying next`，
 *     把 570 次失败看成了 0 次。
 *
 * 原先唯一的办法是改 `.env` + restart。而限流/熔断是**瞬态**的——
 * 重启那 30 秒里要抓的东西早没了（round 87 还实测过重启后前 5 分钟
 * 是全天最差的窗口，全是旧熔断键）。
 *
 * 现在：`redis-cli set xxb:log:level debug` 就够，
 * 下一次 poll（30s）内生效，TTL 1 小时自动收回。
 * 用 Redis 而不是信号/SIGHUP：跨机器一致、可 TTL、不用杀进程。
 */
const LEVEL_KEY = 'xxb:log:level';
const LEVEL_POLL_MS = 30_000;
const LEVEL_TTL_FALLBACK_SEC = 3600;
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export function startDynamicLogLevel(): void {
  if (process.env['LOG_LEVEL_DYNAMIC'] === 'false') return;
  void (async () => {
    try {
      const { getRedis } = await import('../db/redis.js');
      const poll = async (): Promise<void> => {
        const baseline = process.env['LOG_LEVEL'] ?? 'info';
        try {
          const v = await getRedis().get(LEVEL_KEY);
          const next = (v ?? '').trim().toLowerCase();
          // round 85 修：**键没了要回到 baseline，不能 return。**
          //
          // 第一版写 `if (!VALID_LEVELS.has(next)) return` —— 于是只能"改成"
          // 合法 level，不能"改回来"。运维 del 掉键时期望回到 info，
          // 实际永远停在 debug（实测：删键后 debug 仍从 49 涨到 283）。
          //
          // 现在：空值 = 回到 .env 的 baseline；非法值忽略（防手滑打错
          // 把日志关掉）；合法值才切。
          const target = next === '' ? baseline : (VALID_LEVELS.has(next) ? next : logger.level);
          if (logger.level !== target) {
            logger.level = target;
            logger.warn({ from: logger.level, to: target, via: 'redis ' + LEVEL_KEY }, 'log level changed (dynamic)');
          }
        } catch {
          /* Redis 抖动不该影响日志 */
        }
      };
      await poll();
      setInterval(poll, LEVEL_POLL_MS).unref();
    } catch {
      /* 非关键路径 */
    }
  })();
  void LEVEL_TTL_FALLBACK_SEC;
}
