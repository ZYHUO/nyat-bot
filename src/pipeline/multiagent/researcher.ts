// ────────────────────────────────────────
// Multi-Agent 研究员专家 — SEARCH/FETCH 工具子集的 agentic 循环
// ────────────────────────────────────────
//
// 复用 runAgenticPlanner(AI SDK generateText 工具循环),但工具收窄到
// [SEARCH, FETCH] —— 专家只产事实/素材,不直接对用户说话。超时与 turn
// 打断信号合并:超时 → failed(fallback);turn 打断 → 上抛 replan。

import { runAgenticPlanner, type AgenticPlanResult } from '../planner/agentic-loop.js';
import { mergeAbortSignals } from '../../shared/abort.js';
import { env } from '../../env.js';

export interface ResearcherInput {
  messageText: string;
  context: string;
  knowledge?: string;
  chatId: number;
  userId: number;
  turnSignal?: AbortSignal;
}

/** 研究员:用 SEARCH/FETCH 子集跑 agentic 循环,返回工具结果块。 */
export async function runResearcher(input: ResearcherInput): Promise<AgenticPlanResult> {
  const e = env();
  const signal = mergeAbortSignals(e.MULTI_AGENT_RESEARCHER_TIMEOUT_MS, input.turnSignal);
  return runAgenticPlanner({
    messageText: input.messageText,
    context: input.context,
    knowledge: input.knowledge,
    chatId: input.chatId,
    userId: input.userId,
    signal,
    toolFilter: ['SEARCH', 'FETCH'],
    maxStepsOverride: e.MULTI_AGENT_RESEARCHER_MAX_STEPS,
  });
}
