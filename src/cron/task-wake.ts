// ────────────────────────────────────────
// Task wake — AGI Level 6 Phase 13.4
// 到点(next_wake)的任务 → 派发到 task-executor 队列重新执行。
// 连续性的物理实现: bot 被自己的任务唤醒,而不是等消息。
// ────────────────────────────────────────
import { Queue } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { listDueTasks, getTask, researchJobId, tasksEnabled } from '../agent/task-store.js';
import { TASK_QUEUE_NAME } from '../queue/task-worker.js';
import type { TaskJobData } from '../queue/task-worker.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';
import { checkProactiveActivation } from './activation-policy.js';

let _queue: Queue<TaskJobData> | undefined;
function getWakeQueue(): Queue<TaskJobData> {
  if (!_queue) _queue = new Queue<TaskJobData>(TASK_QUEUE_NAME, { connection: getRedis() });
  return _queue;
}

/** Stable wake generation deduplicates queue submissions; SQLite fences execution. */
export async function wakeDueTasks(): Promise<number> {
  if (!tasksEnabled()) return 0;
  const due = listDueTasks();
  if (!due.length) return 0;
  let dispatched = 0;
  for (const t of due) {
    // 已 done/cancelled 的不会在 listDueTasks 里;再防一手竞态
    const fresh = getTask(t.id);
    if (!fresh || fresh.state === 'done' || fresh.state === 'cancelled') continue;
    if (env().PROACTIVE_ACTIVATED_AT_SEC && fresh.created_at <= env().PROACTIVE_ACTIVATED_AT_SEC) continue;
    if (!(await checkProactiveActivation(fresh.chat_id)).allowed) continue;
    await getWakeQueue().add('task_execute', {
      type: 'task_execute',
      taskId: fresh.id,
      chatId: fresh.chat_id,
      ownerUid: fresh.owner_uid,
      wakeGeneration: fresh.wake_generation,
    }, { jobId: researchJobId(fresh), removeOnComplete: true, removeOnFail: true });
    dispatched++;
    logger.info({ taskId: fresh.id, wakeGeneration: fresh.wake_generation }, 'task woken');
  }
  return dispatched;
}
