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
  });
  _worker.on('error', (err) => {
    logger.error({ err: err.message }, 'CodeAct worker error');
  });
  logger.info({ concurrency }, 'CodeAct BullMQ worker started');
  return _worker;
}

export async function closeCodeActWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
