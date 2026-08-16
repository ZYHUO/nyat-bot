// ────────────────────────────────────────
// Task executor — AGI Level 6 Phase 13
// 独立 BullMQ 队列,与消息处理完全隔离。
// 任务循环: 无延迟压力,可跑多轮搜索,完成后主动发结果。
// 只有一种任务类型: research("帮我查 X")。
//
// 安全: 任务创建权限收紧(createTask 由被 @ 的直接请求触发)。
// 多轮搜索: 搜 → 看 → 换词再搜 → 交叉验证 → 完成发回。
// ────────────────────────────────────────
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { executeSearch } from '../pipeline/tools/search.js';
import { callWithFallback } from '../ai/fallback.js';
import { sendMessage } from '../bot/sender/telegram.js';
import {
  getTask, setTaskState, appendLedger, setProgress, bumpSearchRound,
  completeTask, retryTask, tasksEnabled,
} from '../agent/task-store.js';

export const TASK_QUEUE_NAME = 'task-executor';

export interface TaskJobData {
  type: 'task_execute';
  taskId: number;
  chatId: number;
  ownerUid: number;
  /** 上一步结果反馈(如果有) */
  context?: string;
}

let _worker: Worker<TaskJobData> | undefined;

/** 多轮搜索决策: 给定当前结果,决定是继续换词搜还是收尾。返回下一查询或 null 收尾。 */
function decideNextQuery(goal: string, resultsSoFar: string[], round: number, maxRounds: number): string | null {
  if (round >= maxRounds) return null;
  // 启发式: 结果足够多(≥2 轮有效内容)或首轮已包含结论性信息就收尾
  const nonEmpty = resultsSoFar.filter((r) => r && r.length > 80);
  if (nonEmpty.length >= 2 && round >= 2) return null;
  // 简单换词: 让 LLM 决定太重,先按"追问"规则 —— 目标词 + "更多细节"
  if (round === 1) return `${goal} 更多细节`;
  if (round === 2) return `${goal} 最新进展`;
  return null;
}

/**
 * LLM 综合搜索结果 → 一份连贯、结论先行的回答。
 * 作用: 去重、消解矛盾(取多数/最新)、按用户问题组织、标来源。
 * 失败回退 null(调用方用原始拼接)。"AGI 感"的关键一步 —— 查完要"理解并组织",
 * 不是把两个搜索块平铺给对方看。
 */
async function synthesizeResults(goal: string, results: string[]): Promise<string | null> {
  const raw = results.join('\n\n---\n\n').slice(0, 12_000);
  // 一次调用能容下的搜索块;过长截断
  const budget = raw.slice(0, 12_000);
  const prompt = `你是研究助手: 用户让我查「${goal}」,下面是几轮搜索结果(可能重复、矛盾、噪音)。
请综合成一份回答:
1. 直接先给结论(一两句),再给关键细节;不要复述"搜索结果"本身
2. 数字/事实冲突时取多数来源或更新的那一个,并给出最可信的值;矛盾明显时如实说明
3. 去重、去掉噪音和无关内容
4. 保留 2-4 个最有用的来源名(放在末尾 "来源:" 一行)
5. 纯文本,不啰嗦,总量 500 字以内;禁止 markdown/粗体/**列表符号**/* 编号,不要任何标题

搜索结果:
${budget}`;
  try {
    const res = await callWithFallback({
      usage: 'summarize',
      messages: [
        { role: 'system', content: '你是精炼准确的研究综合助手。输出只有正文,不要 JSON、不要标题重复、不要复述输入。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      maxTokens: 1200,
      maxTimeoutMs: 90_000,
    });
    const text = (res.content ?? '').trim();
    if (!text || text.length < 10) return null;
    return text;
  } catch (err) {
    logger.warn({ err, taskId: undefined }, 'synthesize failed, falling back to raw');
    return null;
  }
}

export async function executeTask(job: Job<TaskJobData>): Promise<string | null> {
  const { taskId, chatId } = job.data;
  const task = getTask(taskId);
  if (!task) {
    logger.warn({ taskId }, 'task not found, skipping');
    return null;
  }
  if (task.state === 'cancelled') return null;

  setTaskState(taskId, 'running');

  const goal = task.goal;
  const maxRounds = task.max_rounds;
  const results: string[] = [];
  let round = task.search_round;

  try {
    // 多轮搜索循环: 搜 → 看 → 换词再搜 → 交叉验证
    while (round < maxRounds) {
      const { round: newRound, done } = bumpSearchRound(taskId);
      round = newRound;
      const query = round === 1 ? goal : decideNextQuery(goal, results, round, maxRounds);
      if (!query) break;

      setProgress(taskId, [`正在搜索: ${query}`, ...results.slice(-2).map((r) => `已获得 ${r.length} 字结果`)]);
      const raw = await executeSearch(query);
      results.push(raw);

      appendLedger(taskId, { step: `搜索 #${round}: ${query}`, result: raw.slice(0, 500), ts: Math.floor(Date.now() / 1000) });
      logger.info({ taskId, round, len: raw.length }, 'task search round done');

      if (done) break;
    }

    // 收尾: 先尝试 LLM 综合(去重/消矛盾/结论先行),失败回退原始拼接
    const combined = results.join('\n\n---\n\n');
    if (!combined.trim()) {
      // 所有轮次都没拿到有效结果(重派时 search_round 可能已满)
      completeTask(taskId, combined);
      await sendMessage(chatId, `「${goal}」我没查到新东西,要换个关键词再试吗?`);
      return null;
    }
    const synthesized = await synthesizeResults(goal, results);
    const summary = (synthesized ?? combined).slice(0, 6000);
    completeTask(taskId, summary);
    appendLedger(taskId, { step: '综合', result: synthesized ? `LLM 综合(${summary.length}字)` : '原始拼接(LLM 综合失败)', ts: Math.floor(Date.now() / 1000) });

    // 主动发回结果(任务循环的交付点 —— bot 被自己的任务唤醒后交付)
    const header = `📋 查好了「${goal}」\n`;
    const body = summary.length > 3500 ? `${summary.slice(0, 3500)}…\n\n(内容较长,已存任务台账)` : summary;
    await sendMessage(chatId, header + body);
    return summary;
  } catch (err) {
    logger.error({ err, taskId }, 'task execution failed');
    // 止损: 失败 → 退避重试(15min/2h/1d,上限 3 次),期间不再被 cron 重派。
    // 达上限则终止任务并发"放弃了"文案(reviewer: blocked 死锁 + 无限重派修复)。
    const willRetry = retryTask(taskId);
    setProgress(taskId, [`任务中断: ${err instanceof Error ? err.message : String(err)} (${willRetry ? '稍后重试' : '已放弃'})`]);
    if (willRetry) {
      appendLedger(taskId, { step: '失败', result: `第 ${getTask(taskId)?.retry_count ?? '?'} 次失败: ${err instanceof Error ? err.message : String(err)}`, ts: Math.floor(Date.now() / 1000) });
      await sendMessage(chatId, `⚠️ 「${goal}」查的时候卡住了,我等会儿换个方式再试。`);
    } else {
      await sendMessage(chatId, `⚠️ 「${goal}」试了几次都没查成,先放着吧,你想的话我再找别的方法。`);
    }
    return null;
  }
}

export function startTaskWorker(): void {
  if (_worker || !tasksEnabled()) return;
  _worker = new Worker<TaskJobData>(
    TASK_QUEUE_NAME,
    async (job) => {
      try {
        await executeTask(job);
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'task worker error');
      }
    },
    { connection: getRedis(), concurrency: 2 },
  );
  _worker.on('error', (err) => logger.error({ err }, 'task worker error event'));
  logger.info('Task executor worker started');
}
