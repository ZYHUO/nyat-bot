// ────────────────────────────────────────
// Task executor — AGI Level 6 Phase 13
// 独立 BullMQ 队列,与消息处理完全隔离。
// 任务循环: 无延迟压力,可跑多轮搜索,完成后主动发结果。
// 只有一种任务类型: research("帮我查 X")。
//
// 安全: 任务创建权限收紧(createTask 由被 @ 的直接请求触发)。
// 多轮搜索: 搜 → 看 → 换词再搜 → 摘要 → 完成发回（摘要不等于事实核验）。
// ────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { executeSearchDetailed, formatSearchOutcome } from '../pipeline/tools/search.js';
import { callWithFallback } from '../ai/fallback.js';
import { sendMessageDetailed } from '../bot/sender/telegram.js';
import {
  getTask, appendLedger, tasksEnabled, claimResearchTask, isResearchClaimCurrent, renewResearchClaim,
  bindResearchAgency, listResearchSteps, saveResearchStep, beginResearchDelivery, recordResearchDelivery,
  completeResearchClaim, failResearchClaim, type TaskClaim, type TaskRow,
} from '../agent/task-store.js';
import { createAgencyEnvelope, createAgencyRun, executeAgencyRun, cancelAgencyRun, type AgencyAdapterContext } from '../agent/agency-runtime.js';
import { saveTaskEvidence } from '../agent/task-evidence-store.js';
import { env } from '../env.js';
import { checkProactiveActivation } from '../cron/activation-policy.js';

export const TASK_QUEUE_NAME = 'task-executor';

export interface TaskJobData {
  type: 'task_execute';
  taskId: number;
  chatId: number;
  ownerUid: number;
  wakeGeneration: number;
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
async function synthesizeResults(goal: string, results: string[], signal: AbortSignal): Promise<string | null> {
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
      signal,
    });
    const text = (res.content ?? '').trim();
    if (!text || text.length < 10) return null;
    return text;
  } catch {
    logger.warn('Research synthesis unavailable; retaining source results for retry');
    return null;
  }
}

class ResearchTaskError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
interface SearchStage { status: 'ok' | 'empty'; record: string; partial: boolean }
interface SummaryStage { summary: string; text: string; empty: boolean; partial: boolean }
interface AttemptStats { calls: number; failedCalls: number }

function assertCurrent(claim: TaskClaim, signal?: AbortSignal): void {
  if (signal?.aborted || !tasksEnabled() || !isResearchClaimCurrent(claim)) throw new ResearchTaskError('execution_superseded');
}

/** Agency owns each attempt; the task keeps durable results across attempts. */
async function runResearch(task: TaskRow, claim: TaskClaim, context: AgencyAdapterContext, stats: AttemptStats): Promise<string | null> {
  const { id: taskId, chat_id: chatId, goal } = task;
  const stages = listResearchSteps<SearchStage | SummaryStage>(taskId);
  const searches = stages.filter(step => step.key.startsWith('search:'));
  const results = searches.map(step => step.result as SearchStage).filter(step => step.status === 'ok').map(step => step.record);
  let round = searches.length;
  let searchCalls = 0;
  let partial = searches.some(step => (step.result as SearchStage).partial);
  let summary = stages.find(step => step.key === 'summary')?.result as SummaryStage | undefined;
  // Pre-migration display ledgers contain truncated text, not resumable sources.
  if (task.search_round > round && !summary) throw new ResearchTaskError('legacy_results_unavailable');
  if (!summary) {
    while (round < task.max_rounds) {
      assertCurrent(claim, context.signal);
      const query = round === 0 ? goal : decideNextQuery(goal, results, round, task.max_rounds);
      if (!query) break;
      context.usage.consumeToolCall();
      searchCalls++;
      stats.calls++;
      const outcome = await executeSearchDetailed(query);
      // The provider owns HTTP timeout. Fence its returned value and all later
      // effects; cancellation cannot retract an already-started read request.
      assertCurrent(claim, context.signal);
      if (outcome.status === 'unavailable' || (outcome.status === 'ok' && !outcome.results.length)) {
        stats.failedCalls++;
        throw new ResearchTaskError('search_unavailable');
      }
      const stage: SearchStage = {
        status: outcome.status,
        record: outcome.status === 'ok' ? formatSearchOutcome(query, outcome).slice(0, 24_000) : '',
        partial: outcome.attempts.some(attempt => attempt.status === 'failed'),
      };
      if (!saveResearchStep(claim, { key: `search:${round + 1}`, input: { query }, result: stage }, round + 1)) throw new ResearchTaskError('execution_superseded');
      round++;
      partial ||= stage.partial;
      if (stage.status === 'ok') results.push(stage.record);
      appendLedger(taskId, { step: `搜索 #${round}`, result: stage.status === 'ok' ? stage.record.slice(0, 500) : '本轮无匹配结果；不证明事实不存在。', ts: Math.floor(Date.now() / 1000) });
      logger.info({ taskId, round, searchStatus: outcome.status, sources: outcome.results.length }, 'task search round persisted');
    }
    assertCurrent(claim, context.signal);
    const combined = results.join('\n\n---\n\n');
    if (!combined.trim()) {
      if (!round) throw new ResearchTaskError('search_budget_exhausted');
      const text = `「${goal}」本次搜索已完成，但没有返回匹配结果；这不代表相关信息不存在。` + (partial ? '部分搜索来源未能完成查询。' : '');
      summary = { summary: text, text, empty: true, partial };
    } else {
      context.usage.consumeLlmCall();
      stats.calls++;
      const synthesized = await synthesizeResults(goal, results, context.signal);
      assertCurrent(claim, context.signal);
      if (synthesized === null) {
        stats.failedCalls++;
        throw new ResearchTaskError('synthesis_unavailable');
      }
      partial ||= results.length < round;
      const notice = partial ? '部分检索未获得可用资料，以下仅基于成功返回的来源整理。\n' : '';
      const answer = notice + synthesized.slice(0, 6000 - notice.length);
      const body = answer.length > 3500 ? `${answer.slice(0, 3500)}…\n\n(内容较长,已存任务台账)` : answer;
      summary = { summary: answer, text: `📋 「${goal}」检索摘要（未独立核验）\n` + body, empty: false, partial };
    }
    if (!saveResearchStep(claim, { key: 'summary', input: { searchRounds: round }, result: summary })) throw new ResearchTaskError('execution_superseded');
  }
  assertCurrent(claim, context.signal);
  if (!(await checkProactiveActivation(chatId)).allowed) throw new ResearchTaskError('activation_changed');
  assertCurrent(claim, context.signal);
  // An ACK persisted before a process crash needs settlement, not another send.
  if (getTask(taskId)?.delivery_state !== 'sent') {
    context.usage.consumeToolCall();
    if (!beginResearchDelivery(claim)) throw new ResearchTaskError('delivery_unknown');
    try {
      const delivery = await sendMessageDetailed(chatId, summary.text, undefined, undefined, {
        intentId: `research:${taskId}`, revision: claim.cancelGeneration,
        beforeSend: () => assertCurrent(claim, context.signal),
      });
      if (delivery.chatId !== chatId || delivery.intentId !== `research:${taskId}` || delivery.revision !== claim.cancelGeneration
        || delivery.parts.some(part => !Number.isSafeInteger(part.messageId) || part.messageId <= 0)
        || (delivery.status === 'sent' && (!delivery.parts.length || delivery.parts.length !== delivery.plannedPartCount))) {
        throw new ResearchTaskError('delivery_invalid_receipt');
      }
      const state = delivery.status !== 'sent' && delivery.parts.length > 0 ? 'unknown' : delivery.status;
      // Keep only the receipt contract; transport errors can contain credentials.
      recordResearchDelivery(claim, state, {
        status: state, intentId: delivery.intentId, revision: delivery.revision,
        chatId: delivery.chatId, parts: delivery.parts, plannedPartCount: delivery.plannedPartCount,
      });
      if (state !== 'sent') throw new ResearchTaskError(`delivery_${state}`);
    } catch (error) {
      if (getTask(taskId)?.delivery_state === 'sending') recordResearchDelivery(claim, 'unknown', { status: 'unknown', reason: 'delivery_exception' });
      throw error;
    }
  }
  assertCurrent(claim, context.signal);
  if (!completeResearchClaim(claim, summary.summary)) throw new ResearchTaskError('execution_superseded');
  saveTaskEvidence({ taskId: `research:${taskId}`, chatId, lifecycle: 'done', assessment: 'unverified',
    turns: round, totalCalls: searchCalls + context.usage.llmCalls, failedCalls: 0, retryCount: task.retry_count,
    reasons: [summary.empty ? 'delivered_empty' : 'delivered_synthesized', ...(summary.empty ? ['search_empty'] : []), ...(summary.partial ? ['partial_search'] : [])] });
  return summary.empty ? null : summary.summary;
}

export async function executeTask(job: Job<TaskJobData>): Promise<string | null> {
  if (!tasksEnabled()) return null;
  const { taskId, chatId, ownerUid, wakeGeneration } = job.data;
  const task = getTask(taskId);
  if (!task || task.chat_id !== chatId || task.owner_uid !== ownerUid || !Number.isSafeInteger(wakeGeneration)) return null;
  if (env().PROACTIVE_ACTIVATED_AT_SEC && task.created_at <= env().PROACTIVE_ACTIVATED_AT_SEC) return null;
  if (!(await checkProactiveActivation(chatId)).allowed) return null;
  const claim = claimResearchTask({ taskId, chatId, ownerUid, wakeGeneration, owner: `research:${process.pid}:${randomUUID()}` });
  if (!claim) return null;
  let agencyId: string | undefined;
  let output: string | null = null;
  const stats: AttemptStats = { calls: 0, failedCalls: 0 };
  const heartbeat = setInterval(() => {
    try {
      if (!renewResearchClaim(claim) && agencyId) cancelAgencyRun(agencyId, 'research_claim_lost');
    } catch {
      if (agencyId) cancelAgencyRun(agencyId, 'research_claim_unavailable');
    }
  }, 10_000);
  heartbeat.unref();
  try {
    const envelope = createAgencyEnvelope({
      action: { type: 'act', goal: task.goal, taskId: `research:${taskId}` },
      scope: { visibility: 'task', chatId, userId: ownerUid, taskId: `research:${taskId}` },
      idempotencyKey: `research:${taskId}:owner:${claim.version}`,
      correlationId: `research:${taskId}`,
      budget: { maxMs: 10 * 60_000, maxLlmCalls: 1, maxToolCalls: Math.min(100, task.max_rounds + 1) },
    });
    if (!envelope.ok || !envelope.envelope) throw new ResearchTaskError('agency_envelope_unavailable');
    const created = createAgencyRun(envelope.envelope);
    if (!created.ok || !created.run) throw new ResearchTaskError('agency_run_unavailable');
    agencyId = created.run.id;
    if (!bindResearchAgency(claim, agencyId)) {
      cancelAgencyRun(agencyId, 'research_claim_lost');
      return null;
    }
    // Authorized host adapter: creation permission, account, activation and
    // ownership were checked above. Agency supplies cancellation/budget/receipts.
    const execution = await executeAgencyRun(agencyId, { act: async (_action, context) => {
      output = await runResearch(task, claim, context, stats);
      return { taskId, delivery: getTask(taskId)?.delivery_state };
    } });
    if (!execution.ok && isResearchClaimCurrent(claim)) throw new ResearchTaskError(execution.reason ?? 'execution_failed');
    return output;
  } catch (error) {
    const reason = error instanceof ResearchTaskError ? error.reason : 'execution_failed';
    const held = ['delivery_unknown', 'legacy_results_unavailable', 'activation_changed'].includes(reason);
    const settled = failResearchClaim(claim, reason, held);
    if (settled !== 'stale') saveTaskEvidence({ taskId: `research:${taskId}`, chatId,
      lifecycle: settled === 'retry' ? 'pending' : 'blocked', assessment: 'failed',
      turns: getTask(taskId)?.search_round ?? 0, totalCalls: stats.calls, failedCalls: stats.failedCalls,
      retryCount: getTask(taskId)?.retry_count ?? 0, reasons: [reason] });
    logger.warn({ taskId, reason, settlement: settled }, 'research execution retained for recovery');
    return null;
  } finally {
    clearInterval(heartbeat);
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

/** Graceful backup/shutdown must wait for this writer as well as chat workers. */
export async function closeTaskWorker(): Promise<void> {
  if (!_worker) return;
  const worker = _worker;
  _worker = undefined;
  await worker.close();
}
