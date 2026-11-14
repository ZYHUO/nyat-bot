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
import { checkCodeActTaskActivation, holdCodeActTask, requireCodeActActivation } from './activation-policy.js';

export const CODEACT_QUEUE_NAME = 'xxb-codeact';

let _queue: Queue<DispatchTask> | undefined;
let _worker: Worker<DispatchTask> | undefined;
const failureCleanups = new Set<Promise<void>>();

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
  await requireCodeActActivation(task);
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
  await requireCodeActActivation(task);
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
  const activation = checkCodeActTaskActivation(task);
  if (!activation.allowed) {
    await holdCodeActTask(task, activation.reason);
    // It remains in the separate immutable archive; do not repeatedly retry a
    // task whose chat or creation time is outside this deployment's authority.
    job.discard();
    throw new Error(`codeact_activation_denied:${activation.reason}`);
  }
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
    // Rejected queue data has no authority to mutate a same-ID cached task or
    // clear its chat's active indexes. The original job remains in its archive.
    if (err.message.startsWith('codeact_activation_denied:')) return;
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
    const cleanup = (async () => {
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
    failureCleanups.add(cleanup);
    void cleanup.finally(() => failureCleanups.delete(cleanup));
  });
  _worker.on('error', (err) => {
    logger.error({ err: err.message }, 'CodeAct worker error');
  });
  logger.info({ concurrency }, 'CodeAct BullMQ worker started');
  return _worker;
}

export async function closeCodeActWorker(): Promise<void> {
  // A bounded wait that silently succeeds leaves writers alive after DB close.
  // The process-level deadline exits nonzero; this function only succeeds after
  // the worker, its failed-job handlers, and the queue have actually settled.
  if (_worker) {
    logger.info({ step: 'codeact-worker' }, 'shutdown step');
    await _worker.close();
    _worker = undefined;
  }
  await Promise.all([...failureCleanups]);
  if (_queue) {
    logger.info({ step: 'codeact-queue' }, 'shutdown step');
    await _queue.close();
    _queue = undefined;
  }
}
