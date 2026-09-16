// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent 记忆员专家 — 单次直接 RECALL(2026-06-29 改版)
// ─────────────────────────────────────────────────────────────────────────────
//
// 旧版走 agentic 多步 planner(LLM 决定召回什么)——在忙群老被 turn 打断 /
// 超时,噪声大 yet 收益有限(语义检索一次就够,不需要多轮规划)。改成单次
// 直接 executeRecall(messageText):一次语义检索本群旧对话,命中即注入
// memoryFindings 通道,没命中就不注入。无 LLM 调用 → 无 agentic 超时/打断。
// turn 打断(turnSignal aborted)上抛交给 replan;其它错误 fail-soft 留空。

import { executeRecall } from '../tools/recall.js';
import { isCallerAbort } from '../../shared/abort.js';
import { logger } from '../../shared/logger.js';

export interface MemorySpecialistInput {
  messageText: string;
  context: string;
  knowledge?: string;
  chatId: number;
  userId: number;
  turnSignal?: AbortSignal;
}

export interface MemorySpecialistResult {
  toolResultsBlock?: string;
  toolsUsed: string[];
  failed: boolean;
}

/** 记忆员:一次 RECALL(语义检索本群旧对话)。没命中 → 不注入。 */
export async function runMemorySpecialist(input: MemorySpecialistInput): Promise<MemorySpecialistResult> {
  const q = (input.messageText ?? '').trim();
  if (!q) return { toolsUsed: [], failed: false };
  try {
    const text = await executeRecall(input.chatId, q, 8);
    // executeRecall 在无结果时返回"没有回忆起..."开头;不注入,避免给写手空信息
    if (!text || text.startsWith('没有回忆起') || text.startsWith('没有找到')) {
      return { toolsUsed: ['RECALL'], failed: false };
    }
    return { toolResultsBlock: `[记忆员]\n${text}`, toolsUsed: ['RECALL'], failed: false };
  } catch (err) {
    if (isCallerAbort(input.turnSignal)) throw err; // turn 打断 → 上抛 replan
    logger.debug({ err, chatId: input.chatId }, 'Multi-agent: memory specialist failed (non-critical)');
    return { toolsUsed: [], failed: true };
  }
}
