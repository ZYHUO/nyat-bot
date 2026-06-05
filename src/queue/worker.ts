// ────────────────────────────────────────
// BullMQ Worker — message 处理流水线
// ────────────────────────────────────────

import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { QUEUE_NAME } from "./jobs.js";
import type { MessageJobData } from "./jobs.js";
import { getRedis } from "../db/redis.js";
import { processPipeline } from "../pipeline/pipeline.js";
import { runChatTurn } from "../pipeline/turn/actor.js";
import { handleWaitResume } from "../pipeline/timing/chat-runtime.js";
import { logger } from "../shared/logger.js";
import { env } from "../env.js";

let _worker: Worker<MessageJobData> | undefined;

async function processMessage(job: Job<MessageJobData>): Promise<void> {
  // Turn actor: per-chat cognition turn (drains the pending burst itself)
  if (job.data.type === 'chat_turn') {
    await runChatTurn(job.data, job.id);
    return;
  }

  // Phase 4: wait-resume jobs are routed to chat-runtime, not the regular pipeline
  if (job.data.type === 'wait_resume') {
    await handleWaitResume({
      chatId: job.data.chatId,
      waitResume: job.data.waitResume,
    });
    return;
  }

  await processPipeline({
    type: job.data.type,
    chatId: job.data.chatId,
    messageId: job.data.messageId,
    update: job.data.update,
    enqueuedAt: job.data.enqueuedAt,
    coalesce: job.data.coalesce,
    skipReply: job.data.skipReply,
    waitResume: job.data.waitResume,
  });
}

export function startWorker(): Worker<MessageJobData> {
  if (_worker) return _worker;

  const concurrency = env().QUEUE_CONCURRENCY;

  _worker = new Worker<MessageJobData>(QUEUE_NAME, processMessage, {
    connection: getRedis(),
    concurrency,
    lockDuration: 180_000,     // 3 min — AI calls can be slow
    stalledInterval: 120_000,  // check stalls every 2 min
  });

  _worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Job failed");
  });

  _worker.on("error", (err) => {
    logger.error({ err: err.message }, "Worker error");
  });

  logger.info({ concurrency }, "BullMQ worker started");
  return _worker;
}

export async function closeWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}
