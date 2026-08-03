// ────────────────────────────────────────
// BullMQ Worker — message 处理流水线
// ────────────────────────────────────────

import { Worker, UnrecoverableError } from "bullmq";
import type { Job } from "bullmq";
import { QUEUE_NAME } from "./jobs.js";
import type { MessageJobData } from "./jobs.js";
import { getRedis } from "../db/redis.js";
import { processPipeline } from "../pipeline/pipeline.js";
import { runChatTurn } from "../pipeline/turn/actor.js";
import { handleWaitResume } from "../pipeline/timing/chat-runtime.js";
import { handleDeferResume } from "../pipeline/timing/defer.js";
import { logger } from "../shared/logger.js";
import { env } from "../env.js";

let _worker: Worker<MessageJobData> | undefined;

const KNOWN_JOB_TYPES = new Set<MessageJobData['type']>([
  'message', 'allowlist_review', 'wait_resume', 'chat_turn', 'defer_resume',
]);

async function processMessage(job: Job<MessageJobData>): Promise<void> {
  // 畸形 job(未知 type)直接 UnrecoverableError:重试无意义,也不会让它带着
  // 缺字段的载荷摔进 processPipeline(review finding:无类型校验)。
  if (!job.data || !KNOWN_JOB_TYPES.has(job.data.type)) {
    throw new UnrecoverableError(
      `Unknown job type: ${String((job.data as MessageJobData | undefined)?.type)}`,
    );
  }

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

  // P0-B: defer-resume — 被 gate/心流 defer 的条目到点重注入 + 排即时回合。
  // job.id 作为幂等令牌:BullMQ 重试同一 job 时令牌不变,reinjectDeferEntries
  // 据此保证 exactly-once 注入(review R3#1)。
  if (job.data.type === 'defer_resume') {
    await handleDeferResume({
      chatId: job.data.chatId,
      dedupToken: job.id ?? `defer-${job.data.chatId}-${job.data.enqueuedAt}`,
      deferResume: job.data.deferResume,
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
    // AI 调用可能很慢:lock 太短会被 stalled checker 判死重新投递 → 同一 job
    // 重复执行(duplicate reply)。5min 是"正常回合不会碰到、真卡死又不会等太久"
    // 的折中;更长的生成应改用 job.extendLock。
    lockDuration: 300_000,     // 5 min
    stalledInterval: 120_000,  // check stalls every 2 min
  });

  _worker.on("failed", (job, err) => {
    // 记完整 err 对象(stack+context),只记 message 时生产排障等于盲排。
    logger.error({ jobId: job?.id, jobType: job?.data?.type, err }, "Job failed");
  });

  _worker.on("error", (err) => {
    logger.error({ err }, "Worker error");
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
