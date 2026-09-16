// ────────────────────────────────────────
// Multi-Agent 核查员(Phase 3)— 核查研究员产出的事实断言
// ────────────────────────────────────────
//
// 仅 deep 路径跑(在研究员之后、写手之前)。吃研究员素材 + 用户问题,挑出
// 可疑/未证实/矛盾的断言,产出 [核查员] 块喂写手。无素材或核查通过 → null
// (不注入)。失败 fail-soft → null(不阻塞写手)。

import { callWithFallback } from '../../ai/fallback.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface FactCheckerInput {
  messageText: string;
  researcherFindings: string;
  turnSignal?: AbortSignal;
}

/** 核查员:挑出研究员素材里可疑/未证实/矛盾的断言。无问题或无素材 → null。 */
export async function runFactChecker(input: FactCheckerInput): Promise<string | null> {
  const findings = (input.researcherFindings ?? '').trim();
  if (!findings) return null; // 研究员没产出 → 没东西可核查
  const e = env();
  const systemPrompt =
    '你是事实核查员。给定用户问题和研究员收集的素材,挑出素材里可疑、未证实、或相互矛盾的断言,给出简短核查意见(指出哪条可疑、为什么)。' +
    '如果素材都可靠、无问题,就只回“(核查通过)”。不要编造素材里没有的内容。';
  const userMsg =
    `[用户问题]\n${input.messageText || '(空)'}\n\n[研究员素材]\n${findings}\n\n请核查(≤150字)。`;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 220,
      temperature: 0,
      signal: input.turnSignal,
      maxTimeoutMs: e.MULTI_AGENT_CHECKER_TIMEOUT_MS,
    });
    const text = (result.content ?? '').trim();
    if (!text) return null;
    if (text.includes('核查通过')) return null;
    return `[核查员]\n${text}`;
  } catch (err) {
    logger.debug({ err }, 'Multi-agent fact-checker failed (non-critical)');
    return null;
  }
}
