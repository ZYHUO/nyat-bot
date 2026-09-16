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
import { createTask, listActiveTasks, cancelTask, appendLedger, type TaskRow } from '../../agent/task-store.js';
import { TASK_QUEUE_NAME } from '../../queue/task-worker.js';
import type { TaskJobData } from '../../queue/task-worker.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

// ────────────────────────────────────────
// Task 关联闭环(Phase 13.5): 任务建完后用户再说话,bot 不再无视。
// L0 纯规则分类(0ms,无 LLM,不过度打扰):
//   cancel     — 「算了/别查了/不用了」→ cancelTask + 确认一句
//   progress   — 「怎么样了/查到没/催一下」→ 读 ledger 报进度
//   supplement — 同一目标的补充信息 → appendLedger,worker 下轮可见
// 必须同时满足: @ bot + 有活跃任务 + 文本命中。命中任一才接管,
// 否则返回 null/false 让 judge 走常规路径(不能太过)。
// ────────────────────────────────────────

export type FollowUpAction = 'cancel' | 'progress' | 'supplement';

const CANCEL_RE = /(算了|别查了|别找了|别搜了|不用查了|不用了|取消|别管了|不查了)/;
const PROGRESS_RE = /(怎么样了|查到没|查到了吗|找到没|好了吗|还要多久|催一下|有结果了吗|进度)/;
// 补充信息: 排除问句(疑问句走即时回答,不污染 ledger);且必须与任务
// 目标有字面重叠(共享至少一个内容字),否则就是无关闲聊 —— 不能太过。
const QUESTION_TAIL = /[吗?？]$/;
const GOAL_STOP = new Set(['查', '搜', '找', '帮', '我', '你', '的', '了', '一', '下', '个', '请', '给']);

function goalOverlap(clean: string, goal: string): boolean {
  const goalChars = new Set([...goal].filter((c) => /\p{L}|\p{N}/u.test(c) && !GOAL_STOP.has(c)));
  if (!goalChars.size) return true; // 目标无内容字时不拦(宁可记下)
  return [...clean].some((c) => goalChars.has(c));
}

export interface FollowUpHit { action: FollowUpAction; task: TaskRow; }

/**
 * 纯函数分类: 给定文本 + 该用户的活跃任务, 返回命中或 null。
 * 只看最新一条活跃任务(多任务取 updated_at 最近)。
 */
export function classifyTaskFollowUp(text: string, active: TaskRow[]): FollowUpHit | null {
  const task = active[0];
  if (!task) return null;
  const clean = String(text ?? '').trim();
  if (!clean || clean.length > 200) return null;
  if (CANCEL_RE.test(clean)) return { action: 'cancel', task };
  if (PROGRESS_RE.test(clean)) return { action: 'progress', task };
  if (!QUESTION_TAIL.test(clean) && clean.length >= 4 && clean.length <= 60 && goalOverlap(clean, task.goal)) {
    return { action: 'supplement', task };
  }
  return null;
}

/**
 * pipeline hook: @ + 有活跃任务 + 命中分类 → 接管并返回 true。
 * 新建任务分支(tryCreateResearchTask)优先: 能建成新任务就不当 follow-up。
 */
export async function handleTaskFollowUp(chatId: number, uid: number, text: string, isMentioned: boolean): Promise<boolean> {
  if (!env().TASK_EXECUTOR_ENABLED) return false;
  if (!isMentioned) return false;
  // 新任务意图优先(避免「帮我查 Y」被当成旧任务的补充)
  if (parseResearchRequest(text)) return false;
  const active = listActiveTasks(uid, chatId);
  const hit = classifyTaskFollowUp(text, active);
  if (!hit) return false;
  try {
    if (hit.action === 'cancel') {
      cancelTask(hit.task.id);
      await sendMessage(chatId, `好,不查「${hit.task.goal}」了。`);
    } else if (hit.action === 'progress') {
      let ledger: { step: string; result: string }[] = [];
      try { ledger = JSON.parse(hit.task.ledger) as typeof ledger; } catch { ledger = []; }
      const last = ledger.at(-1);
      const round = hit.task.search_round;
      const text2 = last
        ? `查「${hit.task.goal}」查到第 ${round} 轮了,刚看了${last.step}。`
        : `还在查「${hit.task.goal}」(第 ${round} 轮),有结果就告诉你。`;
      await sendMessage(chatId, text2);
    } else {
      appendLedger(hit.task.id, { step: '用户补充', result: String(text).slice(0, 300), ts: Math.floor(Date.now() / 1000) });
      await sendMessage(chatId, `记下了,查的时候一起看。`);
    }
    logger.info({ taskId: hit.task.id, action: hit.action }, 'task follow-up handled');
    return true;
  } catch (err) {
    logger.error({ err, chatId, uid }, 'task follow-up failed');
    return false;
  }
}

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
// 时间词(今天/明天/最近)是合法目标开头,不算指代。
const PRONOUN_START = /^(你|我|他|她|它|这|那|谁|啥|什么|哪|为啥|多少|怎么|为什|为毛|哪些)/;
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
