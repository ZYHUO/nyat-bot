// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent 人设/关系专家 — 单次直接 QUERY_PERSON_PROFILE(2026-06-29 改版)
// ─────────────────────────────────────────────────────────────────────────────
//
// 旧版走 agentic 多步 planner(QUERY_PERSON_PROFILE + FETCH_HISTORY)——忙群
// 老被 turn 打断/超时。改成单次直接查"对方"的画像/关系:用发送者名字调一次
// executeQueryPersonProfile,命中即注入 memoryFindings(走 knowledge 通道)。
// 无 LLM 调用 → 无 agentic 超时/打断,chat 路径专家 <1s。turn 打断上抛 replan。

import { executeQueryPersonProfile } from '../tools/agent-tools.js';
import { isCallerAbort } from '../../shared/abort.js';
import { logger } from '../../shared/logger.js';

export interface PersonaSpecialistInput {
  messageText: string;
  context: string;
  knowledge?: string;
  chatId: number;
  userId: number;
  /** 发送者全名/用户名 —— 直接查 TA 的画像/关系,无需 LLM 解析名字 */
  senderName: string;
  turnSignal?: AbortSignal;
}

export interface PersonaSpecialistResult {
  toolResultsBlock?: string;
  toolsUsed: string[];
  failed: boolean;
}

/** 人设/关系员:一次 QUERY_PERSON_PROFILE(查对方画像/关系)。没找到 → 不注入。 */
export async function runPersonaSpecialist(input: PersonaSpecialistInput): Promise<PersonaSpecialistResult> {
  const name = (input.senderName ?? '').trim();
  if (!name) return { toolsUsed: [], failed: false };
  try {
    const text = await executeQueryPersonProfile(input.chatId, name);
    // executeQueryPersonProfile 在没找到人时返回"(本群没找到叫..."开头;不注入
    if (!text || text.startsWith('(本群没找到')) {
      return { toolsUsed: ['QUERY_PERSON_PROFILE'], failed: false };
    }
    return { toolResultsBlock: `[人设/关系]\n${text}`, toolsUsed: ['QUERY_PERSON_PROFILE'], failed: false };
  } catch (err) {
    if (isCallerAbort(input.turnSignal)) throw err; // turn 打断 → 上抛 replan
    logger.debug({ err, chatId: input.chatId }, 'Multi-agent: persona specialist failed (non-critical)');
    return { toolsUsed: [], failed: true };
  }
}
