// ────────────────────────────────────────
// BullMQ Producer
// ────────────────────────────────────────

import { Queue } from 'bullmq';
import { QUEUE_NAME } from './jobs.js';
import type { MessageJobData } from './jobs.js';
import type { PendingEntry } from '../pipeline/turn/types.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

let _queue: Queue<MessageJobData> | undefined;

export function getQueue(): Queue<MessageJobData> {
  if (!_queue) {
    _queue = new Queue<MessageJobData>(QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
        attempts: 1,
      },
    });
    logger.info('BullMQ queue created');
  }
  return _queue;
}

export async function enqueue(data: MessageJobData): Promise<string | undefined> {
  const queue = getQueue();
  const editSuffix = data.isEdit ? '-edit' : '';
  const jobId = data.messageId
    ? `msg-${data.chatId}-${data.messageId}${editSuffix}`
    : `msg-${data.chatId}-${Date.now()}`;

  const job = await queue.add(data.type, data, { jobId });
  return job.id;
}

/**
 * Phase 4: schedule a delayed "wait resume" job. When it fires the worker will
 * re-evaluate the chat's WAIT state and either replay judge on the last buffered
 * message or quietly exit if a newer message has already woken the chat.
 *
 * jobId pattern is independent from regular message jobs to avoid collision.
 */
let _waitSeq = 0;

export async function enqueueWaitResume(
  chatId: number,
  waitSec: number,
  anchorMessageId?: number,
  obligationId?: string,
): Promise<string | undefined> {
  const queue = getQueue();
  const scheduledAt = Date.now();
  const jobId = `wait-${chatId}-${scheduledAt}-${_waitSeq++}`;
  const data: MessageJobData = {
    type: 'wait_resume',
    chatId,
    enqueuedAt: scheduledAt,
    update: {} as MessageJobData['update'],
    waitResume: {
      scheduledAt,
      waitSec,
      anchorMessageId,
      obligationId,
    },
  };
  const job = await queue.add('wait_resume', data, {
    jobId,
    delay: waitSec * 1000,
  });
  logger.debug(
    { chatId, waitSec, jobId: job.id, anchorMessageId, obligationId },
    'Wait-resume job scheduled',
  );
  return job.id;
}

/**
 * P0-B: 调度一个 defer-resume 延迟 job。被 defer 的条目放在 job 载荷里
 * (不进 pending)—— 窗口期内不会被别的回合提前 drain,也不碰 turn 调度
 * 指针;到点由 worker 的 handleDeferResume 重注入 + 排即时回合。
 */
export async function enqueueDeferResume(
  chatId: number,
  delayMs: number,
  entries: PendingEntry[],
): Promise<string | undefined> {
  const queue = getQueue();
  const scheduledAt = Date.now();
  const jobId = `defer-${chatId}-${scheduledAt}-${_waitSeq++}`;
  const data: MessageJobData = {
    type: 'defer_resume',
    chatId,
    enqueuedAt: scheduledAt,
    update: {} as MessageJobData['update'],
    deferResume: { scheduledAt, entries },
  };
  // review #5/#6:job 载荷是这批消息在窗口期的**唯一副本**(不在 pending
  // 里),原来的 removeOnFail:true + 队列默认 attempts:1 意味着 resume 那
  // 一刻任何瞬时 Redis 抖动都会让消息连同载荷一起彻底消失、无重试无痕迹
  // ——比修复前的"冷却期静默丢弃"更隐蔽(日志显示"已排程"却再也不会触发)。
  // 加重试自愈瞬时故障;去掉 removeOnFail 覆盖,失败 job 落回队列默认
  // (retain{count:5000},与 wait_resume 一致)方便运维发现并手动回放。
  const job = await queue.add('defer_resume', data, {
    jobId,
    delay: delayMs,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
  });
  logger.debug({ chatId, delayMs, jobId: job.id, entryCount: entries.length }, 'Defer-resume job scheduled');
  return job.id;
}

export async function closeQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
