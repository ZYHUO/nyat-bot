// ────────────────────────────────────────
// Task executor — AGI Level 6 Phase 13
// 独立 BullMQ 队列,与消息处理完全隔离。
// 任务循环: 无延迟压力,可跑多轮搜索,完成后主动发结果。
// 只有一种任务类型: research("帮我查 X")。
//
// 安全: 任务创建权限收紧(createTask 由被 @ 的直接请求触发)。
// 多轮搜索: 搜 → 看 → 换词再搜 → 摘要 → 完成发回（摘要不等于事实核验）。
// ────────────────────────────────────────
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { executeSearchDetailed, formatSearchOutcome } from '../pipeline/tools/search.js';
import { callWithFallback } from '../ai/fallback.js';
import { sendMessage } from '../bot/sender/telegram.js';
import {
  getTask, setTaskState, appendLedger, setProgress, bumpSearchRound,
  completeTask, retryTask, tasksEnabled,
} from '../agent/task-store.js';
import { saveTaskEvidence } from '../agent/task-evidence-store.js';
import { env } from '../env.js';
import { checkProactiveActivation } from '../cron/activation-policy.js';

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
 * 作用: 去重、保留矛盾与不确定性、按用户问题组织、标来源。
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
2. 数字/事实冲突时如实保留矛盾与不确定性,不得仅凭多数或更新日期判定真伪;摘要不是独立事实核验
3. 去重、去掉噪音和无关内容
4. 保留 2-4 个最有用的来源名及原始 URL(放在末尾 "来源:" 一行),不要编造来源
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
            // round 70：去掉写死的 maxTokens（原来是 1200），让它落到 usage 级配置。
      // 1200 是上一个模型够用的遗留；推理模型（step-3.7-flash 的
      // reasoning_content 计入 completion）下一个 prompt 的思维链就超过它，
      // 于是 content 恒空。上面 topic-scan 的注释早就写了这个病因，值没跟着改——
      // 同 round 69 的 ASI rubric：**代码知道病因而配了错的值**。

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

class ResearchTaskError extends Error {
  constructor(readonly reason: 'search_unavailable' | 'search_budget_exhausted' | 'delivery_not_confirmed' | 'activation_changed') {
    super(reason);
  }
}

export async function executeTask(job: Job<TaskJobData>): Promise<string | null> {
  if (!tasksEnabled()) return null;
  const { taskId, chatId } = job.data;
  const task = getTask(taskId);
  if (!task) {
    logger.warn({ taskId }, 'task not found, skipping');
    return null;
  }
  if (task.state === 'cancelled' || task.state === 'done') return null;
  if (env().PROACTIVE_ACTIVATED_AT_SEC && task.created_at <= env().PROACTIVE_ACTIVATED_AT_SEC) {
    logger.info({ taskId }, 'Restored task retained in history; awaiting explicit recreation');
    return null;
  }
  if (!(await checkProactiveActivation(chatId)).allowed) return null;

  setTaskState(taskId, 'running');
  const goal = task.goal;
  const maxRounds = task.max_rounds;
  const results: string[] = [];
  let round = task.search_round;
  let searchCalls = 0;
  let unavailableQueries = 0;
  let emptyQueries = 0;
  let partial = false;
  let synthesisAttempted = false;
  let synthesisFailed = false;
  let deliveryAttempted = false;

  // Recheck the destination after potentially slow searches/LLM calls. A duplicate skip (-1)
  // is not a Telegram delivery receipt and must not produce a delivered evidence record.
  const deliver = async (text: string): Promise<void> => {
    if (!tasksEnabled() || !(await checkProactiveActivation(chatId)).allowed) {
      throw new ResearchTaskError('activation_changed');
    }
    deliveryAttempted = true;
    const messageId = await sendMessage(chatId, text);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new ResearchTaskError('delivery_not_confirmed');
    }
  };

  try {
    // Only successful source-bearing outcomes enter results; status text is never evidence.
    while (round < maxRounds) {
      const query = round === 0 ? goal : decideNextQuery(goal, results, round, maxRounds);
      if (!query) break;
      const { round: newRound, done } = bumpSearchRound(taskId);
      round = newRound;

      setProgress(taskId, [`正在搜索: ${query}`, ...results.slice(-2).map((r) => `已获得 ${r.length} 字结果`)]);
      searchCalls += 1;
      const outcome = await executeSearchDetailed(query);
      partial ||= outcome.attempts.some((attempt) => attempt.status === 'failed');
      let record: string;
      if (outcome.status === 'ok' && outcome.results.length) {
        record = formatSearchOutcome(query, outcome);
        results.push(record);
      } else if (outcome.status === 'empty') {
        emptyQueries += 1;
        record = '搜索完成，但本轮未返回匹配结果；不能据此判断相关事实不存在。';
      } else {
        unavailableQueries += 1;
        record = '搜索不可用，本轮未获得有效证据。';
      }

      appendLedger(taskId, { step: `搜索 #${round}: ${query}`, result: record.slice(0, 500), ts: Math.floor(Date.now() / 1000) });
      logger.info({ taskId, round, searchStatus: outcome.status, sources: outcome.results.length }, 'task search round done');

      if (done) break;
    }

    const combined = results.join('\n\n---\n\n');
    if (!combined.trim()) {
      // A provider failure or an exhausted previous run is not a completed empty query.
      if (unavailableQueries) throw new ResearchTaskError('search_unavailable');
      if (!emptyQueries) throw new ResearchTaskError('search_budget_exhausted');
      const notice = `「${goal}」本次搜索已完成，但没有返回匹配结果；这不代表相关信息不存在。`
        + (partial ? '部分搜索来源未能完成查询。' : '');
      await deliver(notice);
      completeTask(taskId, notice);
      saveTaskEvidence({ taskId: `research:${taskId}`, chatId,
        lifecycle: 'done', assessment: 'unverified',
        turns: round, totalCalls: searchCalls, failedCalls: 0, retryCount: task.retry_count,
        reasons: ['delivered_empty', 'search_empty', ...(partial ? ['partial_search'] : [])] });
      return null;
    }
    synthesisAttempted = true;
    const synthesized = await synthesizeResults(goal, results);
    synthesisFailed = synthesized === null;
    partial ||= unavailableQueries > 0 || emptyQueries > 0;
    const notice = partial ? '部分检索未获得可用资料，以下仅基于成功返回的来源整理。\n' : '';
    const summary = notice + (synthesized ?? combined).slice(0, 6000 - notice.length);
    appendLedger(taskId, { step: '综合', result: synthesized ? `LLM 综合(${summary.length}字)` : '原始拼接(LLM 综合失败)', ts: Math.floor(Date.now() / 1000) });

    const header = `📋 「${goal}」检索摘要（未独立核验）\n`;
    const body = summary.length > 3500 ? `${summary.slice(0, 3500)}…\n\n(内容较长,已存任务台账)` : summary;
    await deliver(header + body);
    completeTask(taskId, summary);
    // Delivery is an observed lifecycle event. LLM synthesis is not factual verification.
    saveTaskEvidence({ taskId: `research:${taskId}`, chatId,
      lifecycle: 'done', assessment: 'unverified',
      turns: round, totalCalls: searchCalls + 1, failedCalls: unavailableQueries + Number(synthesisFailed), retryCount: task.retry_count,
      reasons: [synthesized ? 'delivered_synthesized' : 'delivered_raw_fallback', ...(partial ? ['partial_search'] : [])] });
    return summary;
  } catch (err) {
    logger.error({ err, taskId }, 'task execution failed');
    // 止损: 失败 → 退避重试(15min/2h/1d,上限 3 次),期间不再被 cron 重派。
    // 达上限则终止任务并发"放弃了"文案(reviewer: blocked 死锁 + 无限重派修复)。
    const willRetry = retryTask(taskId);
    const reason = err instanceof ResearchTaskError ? err.reason : deliveryAttempted ? 'delivery_failed' : 'execution_failed';
    saveTaskEvidence({ taskId: `research:${taskId}`, chatId,
      lifecycle: willRetry ? 'pending' : 'blocked', assessment: 'failed',
      turns: round, totalCalls: searchCalls + Number(synthesisAttempted),
      failedCalls: unavailableQueries + Number(synthesisFailed), retryCount: getTask(taskId)?.retry_count ?? task.retry_count,
      reasons: [reason] });
    setProgress(taskId, [`任务中断: ${err instanceof Error ? err.message : String(err)} (${willRetry ? '稍后重试' : '已放弃'})`]);
    if (willRetry) {
      appendLedger(taskId, { step: '失败', result: `第 ${getTask(taskId)?.retry_count ?? '?'} 次失败: ${err instanceof Error ? err.message : String(err)}`, ts: Math.floor(Date.now() / 1000) });
    }
    // Do not immediately send a second message after an ambiguous delivery failure.
    if (!deliveryAttempted && reason !== 'activation_changed') {
      const detail = reason === 'search_unavailable' ? '搜索服务当前不可用，尚未获得有效查询结果' : '这次查询未能完成';
      try {
        await deliver(`⚠️ 「${goal}」${detail}。${willRetry ? '已安排稍后重试。' : '已停止自动重试。'}`);
      } catch { /* Failure notices cannot turn a failed research task into a delivery success. */ }
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
