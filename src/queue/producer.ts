// ────────────────────────────────────────
// BullMQ Producer
// ────────────────────────────────────────

import { Queue } from 'bullmq';
import { QUEUE_NAME } from './jobs.js';
import type { MessageJobData } from './jobs.js';
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
    },
  };
  const job = await queue.add('wait_resume', data, {
    jobId,
    delay: waitSec * 1000,
  });
  logger.debug(
    { chatId, waitSec, jobId: job.id, anchorMessageId },
    'Wait-resume job scheduled',
  );
  return job.id;
}

export async function closeQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
