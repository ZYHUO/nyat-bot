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

export async function closeQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = undefined;
  }
}
