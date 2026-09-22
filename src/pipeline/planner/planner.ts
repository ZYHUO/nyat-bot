import { callWithFallback } from '../../ai/fallback.js';
import { loadPrompt, getConfig } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { parsePlannerResponse } from './parser.js';
import type { PlannerInput, ToolPlan } from './types.js';

function buildPlannerUserPrompt(input: PlannerInput): string {
  const sections: string[] = [];

  if (input.availableTools && input.availableTools.length > 0) {
    sections.push(`[AVAILABLE_TOOLS]\n${input.availableTools.join('\n')}`);
  }

  sections.push(`[CURRENT_MESSAGE]\n${input.messageText || '[空消息]'}`);
  sections.push(`[CONTEXT]\n${input.context || '[无上下文]'}`);

  if (input.knowledge?.trim()) {
    sections.splice(1, 0, `[KNOWLEDGE]\n${input.knowledge.trim()}`);
  }

  return sections.join('\n\n');
}

export { parsePlannerResponse } from './parser.js';

export async function planReply(input: PlannerInput): Promise<ToolPlan> {
  const config = getConfig();
  const systemPrompt = loadPrompt('task/planner.md', config.promptsDir);

  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildPlannerUserPrompt(input) },
      ],
      // round 26: 去掉写死的 maxTokens: 300。usage=judge, 链头 step-3.7-flash 是
      // reasoning 模型, 思维链吃光 300 -> 空正文 -> rejectEmpty -> 全链被试完。
      // 同 round 19/26 一路: 写死会压过 .env 配置。
      temperature: 0,
    });

    return parsePlannerResponse(result.content);
  } catch (err) {
    logger.warn({ err }, 'Planner failed, falling back to direct final writer');
    return {
      needTools: false,
      answerStrategy: 'direct',
      steps: [],
    };
  }
}
