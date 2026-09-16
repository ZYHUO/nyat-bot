// ────────────────────────────────────────
// Task wake — AGI Level 6 Phase 13.4
// 到点(next_wake)的任务 → 派发到 task-executor 队列重新执行。
// 连续性的物理实现: bot 被自己的任务唤醒,而不是等消息。
// ────────────────────────────────────────
import { Queue } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { listDueTasks, getTask } from '../agent/task-store.js';
import { TASK_QUEUE_NAME } from '../queue/task-worker.js';
import type { TaskJobData } from '../queue/task-worker.js';
import { logger } from '../shared/logger.js';

let _queue: Queue<TaskJobData> | undefined;
function getWakeQueue(): Queue<TaskJobData> {
  if (!_queue) _queue = new Queue<TaskJobData>(TASK_QUEUE_NAME, { connection: getRedis() });
  return _queue;
}

/** 每分钟 cron: 找出到点的任务,派发执行。幂等: worker 端 getTask 判 state。 */
export async function wakeDueTasks(): Promise<number> {
  const due = listDueTasks();
  if (!due.length) return 0;
  let dispatched = 0;
  for (const t of due) {
    // 已 done/cancelled 的不会在 listDueTasks 里;再防一手竞态
    const fresh = getTask(t.id);
    if (!fresh || fresh.state === 'done' || fresh.state === 'cancelled') continue;
    await getWakeQueue().add('task_execute', {
      type: 'task_execute',
      taskId: t.id,
      chatId: t.chat_id,
      ownerUid: t.owner_uid,
    });
    dispatched++;
    logger.info({ taskId: t.id, goal: t.goal, trigger: t.wake_trigger }, 'task woken');
  }
  return dispatched;
}
