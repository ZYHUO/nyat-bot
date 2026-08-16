// ────────────────────────────────────────
// Task trigger — AGI Level 6 Phase 13.2/13.3
// 在 judge L0 层识别「帮我查 X」类直接请求 → 建 Task → 回「我去查」→ 入队。
//
// 安全铁律(Claude 讨论 + plan): Task 创建权限收紧 ——
//   1. 必须 @ bot(纯文本 @/昵称匹配,pipeline hook 里已确认;reply 不算 mention)
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
// 动词支持叠词(查查/搜搜/找找)。去掉口语化「看/了解」——"你看看这个"不是任务。
const RESEARCH_RE = /(?:帮我|给我|请|麻烦|帮忙|替我)?\s*((?:查|搜|找){1,2})\s*(?:一下|一哈|点|些)?\s*(.*)/;
const RESEARCH_KEYWORDS = /(查|搜|找)/;
// 代词/指示词拒绝集: 以这些开头的 target 是闲聊指代,不是任务目标。
const PRONOUN_START = /^(你|我|他|她|它|这|那|谁|啥|什么|几|哪|今|明|怎么|为什么|哪些|多少)/;
// 尾部非目标从句(用户补充说明"先别急"等) + 转折开头("不过/但是 先别")。
const TAIL_CLAUSE = /(不过|但是|但)?\s*(先别|不急|等会|再说|算了|回头|稍后|晚点|之后|别急|慢慢|不用急).*$/;

/**
 * 尝试把消息解释为 research 任务。返回任务目标或 null。
 * 严格: 必须 @ bot(mention 已在调用方确认)+ 含研究类动词 + 有名词性目标。
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
  if (!RESEARCH_KEYWORDS.test(verb)) return null;

  // 目标净化: 去前导非字母数字 + 截掉尾部从句
  let target = (m[2] ?? '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
  target = target.replace(TAIL_CLAUSE, '').trim();
  if (target.length < 2) return null;
  // 直接疑问句不建任务(应即时回答)
  if (/[吗?？]$/.test(target)) return null;
  // 代词/指示词开头是闲聊指代
  if (PRONOUN_START.test(target)) return null;
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
