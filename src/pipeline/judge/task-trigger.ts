// ────────────────────────────────────────
// Task trigger — AGI Level 6 Phase 13.2/13.3
// 在 judge L0 层识别「帮我查 X」类直接请求 → 建 Task → 回「我去查」→ 入队。
//
// 安全铁律(Claude 讨论 + plan): Task 创建权限收紧 ——
//   1. 必须 @ bot 或 reply bot(直接请求)
//   2. 只认 research 类意图(帮我查/搜/找资料)
//   3. 群里随便一句话(没 @)永不建任务
// ────────────────────────────────────────
import { Queue } from 'bullmq';
import { getRedis } from '../../db/redis.js';
import { createTask } from '../../agent/task-store.js';
import { TASK_QUEUE_NAME } from '../../queue/task-worker.js';
import type { TaskJobData } from '../../queue/task-worker.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

let _queue: Queue<TaskJobData> | undefined;
function getTaskQueue(): Queue<TaskJobData> {
  if (!_queue) _queue = new Queue<TaskJobData>(TASK_QUEUE_NAME, { connection: getRedis() });
  return _queue;
}

// 研究类意图: 帮我查/帮我搜/查一下/搜一下/找找资料/帮我找/查查
// 动词支持叠词(查查/搜搜/找找/看看)。
const RESEARCH_RE = /(?:帮我|给我|请|麻烦|帮忙|替我)?\s*((?:查|搜|找|看|了解){1,2})\s*(?:一下|一哈|点|些)?\s*(.*)/;
const RESEARCH_KEYWORDS = /(查|搜|找|了解|看)/;

/**
 * 尝试把消息解释为 research 任务。返回任务目标或 null。
 * 严格: 必须 @ bot(mention 已在调用方确认)+ 含研究类动词 + 有目标对象。
 */
export function parseResearchRequest(text: string): string | null {
  const clean = text
    .replace(/@\w+/g, '')        // 去掉 @bot
    .replace(/^[,，。.\s]+/, '')  // 去掉 @bot 后的标点/空格
    .trim();
  if (clean.length < 4) return null;
  const m = RESEARCH_RE.exec(clean);
  if (!m) return null;
  const verb = m[1] ?? '';
  const target = (m[2] ?? '').trim();
  if (!RESEARCH_KEYWORDS.test(verb)) return null;
  if (target.length < 2) return null;
  // 排除明显非任务的闲聊
  if (/你|我|他|她|它/.test(target.slice(0, 1))) return null;
  return target;
}

/**
 * judge L0 hook: 用户 @ 了 bot 且消息像「帮我查 X」→ 建任务 + 入队 + 回「我去查」。
 * 返回 true 表示已接管(judge 不再走常规回复路径)。
 */
export async function tryCreateResearchTask(
  chatId: number,
  uid: number,
  text: string,
  isMentioned: boolean,
): Promise<boolean> {
  if (!env().TASK_EXECUTOR_ENABLED) return false;
  // 安全铁律: 必须 @ bot 的直接请求
  if (!isMentioned) return false;
  const goal = parseResearchRequest(text);
  if (!goal) return false;

  try {
    const taskId = createTask({ ownerUid: uid, chatId, goal });
    await getTaskQueue().add('task_execute', { type: 'task_execute', taskId, chatId, ownerUid: uid });
    await sendMessage(chatId, `🔍 我去查「${goal}」,查到就回来告诉你。`);
    logger.info({ taskId, chatId, uid, goal }, 'research task created');
    return true;
  } catch (err) {
    logger.error({ err, chatId, uid }, 'task creation failed');
    return false;
  }
}
