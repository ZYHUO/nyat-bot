// BullMQ queue for durable CodeAct execution (survives process restart).

import { Queue, Worker, DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type { DispatchTask } from '../meta/types.js';
import { getGlobalState } from '../meta/global-state.js';
import {
  tryMarkCodeActActive,
  clearCodeActActive,
  persistCodeActTask,
} from './task-store.js';
import { emitTaskRuntimeEvent } from '../agent/task-runtime-events.js';

export const CODEACT_QUEUE_NAME = 'xxb-codeact';

let _queue: Queue<DispatchTask> | undefined;
let _worker: Worker<DispatchTask> | undefined;

export function getCodeActQueue(): Queue<DispatchTask> {
  if (!_queue) {
    _queue = new Queue<DispatchTask>(CODEACT_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
        attempts: 8,
        backoff: { type: 'fixed', delay: 2500 },
      },
    });
  }
  return _queue;
}

/** Persist + enqueue; falls back to in-process runner if Redis/BullMQ fails. */
export async function enqueueCodeActJob(task: DispatchTask): Promise<void> {
  const state = getGlobalState();
  if (task.status !== 'running') task.status = 'queued';
  state.putTask(task);
  await persistCodeActTask(task);

  try {
    await getCodeActQueue().add('codeact', task, {
      jobId: `codeact-${task.id}`,
    });
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'CodeAct BullMQ enqueue failed — in-process fallback');
    const { enqueueSubagentTaskLocal } = await import('./executor.js');
    enqueueSubagentTaskLocal(task);
  }
  emitTaskRuntimeEvent({
    kind: 'task_queued',
    taskId: task.id,
    chatId: task.chatId,
    segment: task.segment,
    cognitiveAnchorEventId: task.cognitiveAnchorEventId,
  });
}

/**
 * 长时间 Agent 循环：续跑入队。独立 jobId（避免覆盖正在跑的 segment job），
 * attempts=1（checkpoint 本身 durable，失败下段重入队即可，重试 8 次只会放大问题）。
 */
export async function enqueueResumeCodeActJob(task: DispatchTask): Promise<void> {
  const state = getGlobalState();
  task.status = 'queued';
  state.putTask(task);
  await persistCodeActTask(task);

  try {
    await getCodeActQueue().add(
      'codeact',
      task,
      {
        jobId: `codeact-${task.id}-seg${task.segment ?? 0}`,
        attempts: 1,
      },
    );
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'CodeAct resume enqueue failed — in-process fallback');
    const { enqueueSubagentTaskLocal } = await import('./executor.js');
    enqueueSubagentTaskLocal(task);
  }
  emitTaskRuntimeEvent({
    kind: 'task_queued',
    taskId: task.id,
    chatId: task.chatId,
    segment: task.segment,
    cognitiveAnchorEventId: task.cognitiveAnchorEventId,
  });
}

async function processCodeActJob(job: Job<DispatchTask>, token?: string): Promise<void> {
  const task = job.data;
  const got = await tryMarkCodeActActive(task.chatId, task.id);
  if (!got) {
    if (token) {
      await job.moveToDelayed(Date.now() + 2500, token);
      throw new DelayedError();
    }
    throw new Error('codeact_chat_busy');
  }

  try {
    const { runCodeActTask } = await import('./executor.js');
    await runCodeActTask(task);
  } finally {
    await clearCodeActActive(task.chatId, task.id);
  }
}

export function startCodeActWorker(): Worker<DispatchTask> {
  if (_worker) return _worker;
  const concurrency = env().CODEACT_CONCURRENCY;
  _worker = new Worker<DispatchTask>(CODEACT_QUEUE_NAME, processCodeActJob, {
    connection: getRedis(),
    concurrency,
    lockDuration: 300_000,
    stalledInterval: 120_000,
  });
  _worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, 'CodeAct job failed');
    // round 102: **超时的 job 也要解注内。**
    //
    // 现场：task 25249feb 在 09-23 18:51 UTC `job stalled more than allowable limit`
    // 失败，但 `xxb:agent:active-chat:{chat}` 这个 24h 索引没清——
    // 因为 `unregisterAgentChat` 只在 executor 的正常终态和异常逃逐
    // 两条路径上调，而 **stall 的原进程根本没返回**（卡死或挂死）。
    // 后果：之后 4.5 小时里每句群话都被当成 interrupt（里面 9 条 background）。
    //
    // `clearCodeActActive` 清的是 `xxb:codeact:active:`（isCodeActBusy 用），
    // 而 interrupt 路由读的是 `xxb:agent:active-chat:` — **两个不同的 key**。
    // 所以这里两个都清，并且把任务状态改成 failed（防只清 key 而 task 还写着 running）。
    void (async () => {
      const d = job?.data;
      if (!d || typeof d.chatId !== 'number' || !d.id) return;
      try {
        const { unregisterAgentChat } = await import('../agent/checkpoint.js');
        const { clearCodeActActive, persistCodeActTask, loadCodeActTask } = await import('./task-store.js');
        await unregisterAgentChat(d.chatId, d.id).catch(() => {});
        await clearCodeActActive(d.chatId, d.id).catch(() => {});
        // 状态改 failed：interrupt 路由的活性校验会看 status，
        // 只清 key 的话如果 key 被别处重写还会路由过来。
        const t = await loadCodeActTask(d.id).catch(() => null);
        if (t && (t.status === 'running' || t.status === 'queued' || t.status === 'waiting_user')) {
          t.status = 'failed';
          await persistCodeActTask(t).catch(() => {});
        }
        logger.info({ chatId: d.chatId, taskId: d.id }, 'CodeAct job failed — chat task index cleared');
      } catch {
        /* 清理失败不要再把 worker 拒了 */
      }
    })();
  });
  _worker.on('error', (err) => {
    logger.error({ err: err.message }, 'CodeAct worker error');
  });
  logger.info({ concurrency }, 'CodeAct BullMQ worker started');
  return _worker;
}

export async function closeCodeActWorker(): Promise<void> {
  // round 189：**分步日志 + 各自的超时。**
  //
  // 实测（全日志 384 次关机）：53 次 forced exit，其中 **48 次卡在这一步**
  // （最后一条 shutdown step 是 cron），只有 3 次卡在 worker、2 次在 ingress。
  // 而 round 64 修的是 closeRedis（redis+db 步）——那个步现在一次都没卡过，
  // 说明**故障搬了家**：`_worker.close()` / `_queue.close()` 会等在飞 job 或
  // 等一个已经不回的 Redis 连接，整条关机链就停在这儿。
  //
  // 代价不只是"重启慢"：forced exit 是 process.exit(1)，systemd 记失败；
  // 而 index.ts 的注释写明 status=9/KILL 会跳过 WAL checkpoint / token 记账 /
  // BullMQ 锁释放。所以这一步卡住是在丢数据。
  //
  // 分步日志是为了下次能看出是 worker 还是 queue；超时照 round 64 的形状
  // （赛跑 + 不等就往下走）——关机已经决定了，不应该被一个子系统拖死。
  const withTimeout = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await Promise.race([fn(), new Promise<void>((r) => setTimeout(r, 5000).unref())]);
    } catch (err) {
      logger.debug({ err, name }, 'closeCodeActWorker step failed (non-fatal during shutdown)');
    }
  };
  if (_worker) {
    logger.info({ step: 'codeact-worker' }, 'shutdown step');
    await withTimeout('worker', () => _worker!.close());
    _worker = undefined;
  }
  if (_queue) {
    logger.info({ step: 'codeact-queue' }, 'shutdown step');
    await withTimeout('queue', () => _queue!.close());
    _queue = undefined;
  }
}
