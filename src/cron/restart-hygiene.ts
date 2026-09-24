import { logger } from '../shared/logger.js';

/**
 * round 85：**进程卫生告警**——把"重启很频"变成一个可见的信号。
 *
 * round 63 只在启动时打一句话（说明进程内闸在这里清零），
 * 那只解决了"下一个看日志的人知道为什么闸可能是 0"。
 * round 84 排期时发现它其实不贵（差的只是轮次）——那这轮做。
 *
 * 判据（round 44 量的）：09-22..23 重启 111 次，平均进程寿命 21 分钟，p50 只有 7 分钟。
 * 而若干闸的判据状态是进程内 Map（如 recentBotTextsByChat），
 * 要攒满 6 条自己发的话才开始判——开发期基本攒不满。
 *
 * 做什么：**每小时数一次本进程启动以来的寿命**。
 * 这不是告警（告警会告腰），是**一个组件可读的量纸带**。
 * 当它短于 15 分钟，说明这段时间里进程内闸永远攒不满窗口——
 * 那么此时"闸拦 0 次"一律读作"没机会"。
 */

/** 这个进程启动的时间戳（每次重启都会变）。 */
const bootedAtSec = Math.floor(Date.now() / 1000);

/** 低于这个寿命就说"进程内闸攒不满窗口"。 */
const SHORT_LIVED_SEC = 15 * 60;

/** 多久记一次。 */
const EVERY_SEC = 3600;

let lastLogSec = 0;

export async function logProcessBootContext(): Promise<void> {
  logger.info({
    bootedAtSec,
    note: 'process-boot context: in-process guard state (e.g. recentBotTextsByChat) resets here. '
      + 'A guard showing 0 blocks shortly after a restart means it was never given a chance, '
      + 'not that it had no effect (round 44/63: average process lifetime 21 min, p50 7 min).',
  }, 'process boot context (in-process guards reset)');
}

/**
 * 每小时喘一次的生命量纸。由 cron 调度器调。
 *
 * 不存 Redis、不查状态——它只看自己这个进程活了多久。
 * 那个数字已经足够回答"进程内闸现在是不是盲的"。
 */
/**
 * round 105: **残留活动任务索引的自愈摧拦。**
 *
 * Round 102-105 的故事：CodeAct job `stalled more than allowable limit` 失败，
 * 但 `xxb:codeact:tasks` hash 里 status 还是 `running`、`xxb:agent:active-chat:{chat}`
 * 索引还在——结果 5 小时里每句群话都被当成 interrupt。
 *
 * Round 103 修的是"未来的 failed 事件要清"，那已经坏掉的状态没人管。
 * round 104 我还因为查了错的 redis db 认为"查不出来"。
 *
 * 规则（保守，只清肯定是死的）：
 *   - status 是 `running` / `queued`  且 createdAt 超过 STALE_TASK_SEC
 *   - **`waiting_user` 不清**——它合法地在等人，可能等很久
 *   - hash 里已经没有了的索引（纯死键）也清
 *
 * 为什么 2 小时：CodeAct 单段任务预算 30 轮/120s（CLAUDE.md），
 * 即使拖成长任务也是分段续跑，120s 的数十倍仍然安全。
 */
const STALE_TASK_SEC = 2 * 3600;

export async function sweepStaleAgentTasks(): Promise<{ cleared: string[]; checked: number }> {
  const cleared: string[] = [];
  let checked = 0;
  try {
    const redis = (await import('../db/redis.js')).getRedis();
    const { unregisterAgentChat } = await import('../agent/checkpoint.js');
    const { loadCodeActTask, persistCodeActTask } = await import('../subagent/task-store.js');
    const keys = await redis.keys('xxb:agent:active-chat:*');
    const now = Math.floor(Date.now() / 1000);
    for (const k of keys) {
      const chatId = Number(k.slice('xxb:agent:active-chat:'.length));
      const taskId = await redis.get(k);
      if (!taskId || !Number.isFinite(chatId)) { cleared.push(k); continue; }
      checked++;
      const t = await loadCodeActTask(taskId);
      if (!t) {                                  // 形态 B：hash 已过期，索引是纯死键
        await redis.del(k);
        cleared.push(`${k} (task gone)`);
        continue;
      }
      if (t.status !== 'running' && t.status !== 'queued') continue;   // waiting_user/done/failed 都不碰
      const age = now - (t.createdAt ?? 0);
      if (age < STALE_TASK_SEC) continue;
      t.status = 'failed';
      await persistCodeActTask(t);
      await unregisterAgentChat(chatId, taskId);
      cleared.push(`${k} (task ${taskId.slice(0, 8)} age ${Math.round(age / 60)}min, marked failed)`);
      logger.warn({ chatId, taskId, ageMin: Math.round(age / 60) },
        'agent: stale running task swept (index cleared, status failed)');
    }
  } catch (err) {
    logger.warn({ err }, 'sweepStaleAgentTasks failed (non-fatal)');
  }
  // round 110: **健康时也要打一行**。
  //
  // 原来只在清了东西时才打 warn——那意味着"扫描 0 次"和
  // "从没跑过"一样。而这个摧拦就是 round 102-106 那个僵尸任务的防复发，
  // 如果它自己没跑，我上一轮根本知道不了。
  //
  // 频率：小时级（24 行/天），不到刷屏的程度。
  logger.info({
    checked,
    cleared: cleared.length,
    detail: cleared.join(' | ') || '(nothing to clear)',
  }, 'agent sweep: stale running-task indexes scanned');
  return { cleared, checked };
}

export function reportProcessLifetime(): void {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastLogSec < EVERY_SEC) return;
  lastLogSec = now;
  const ageSec = now - bootedAtSec;
  const short = ageSec < SHORT_LIVED_SEC;
  logger.info({
    ageSec,
    ageMin: Math.round(ageSec / 60),
    bootedAtSec,
    shortLived: short,
  }, short
    ? 'process lifetime: short — in-process guard windows cannot fill; read "guard blocked 0" as "no chance"'
    : 'process lifetime: steady — in-process guard windows can fill now');
}
