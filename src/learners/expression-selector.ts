import { callWithFallback } from '../ai/fallback.js';
import { loadCachedPrompt } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getTopExpressions } from './expression-learner.js';
import type { ExpressionEntry } from './types.js';

/**
 * Use LLM to select N expressions matching the current context.
 * Falls back to top-by-count if LLM fails.
 */
export async function selectExpressions(
  chatId: number,
  contextSummary: string,
  maxCount: number,
  usage: string,
): Promise<ExpressionEntry[]> {
  const all = getTopExpressions(chatId, 30);
  if (all.length === 0) return [];
  if (all.length <= maxCount) return all;

  const situationList = all.map((e, i) => `${i}: ${e.situation}`).join('\n');

  let systemPrompt: string;
  try {
    systemPrompt = loadCachedPrompt('task/expression-select.md');
  } catch {
    return all.slice(0, maxCount);
  }

  try {
    const result = await callWithFallback({
      usage,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `当前语境：${contextSummary}\n\n可选情境列表：\n${situationList}\n\n请选择最多${maxCount}个最匹配的情境编号。` },
      ],
      maxTokens: 100,
      temperature: 0,
    });

    const raw = result.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return all.slice(0, maxCount);

    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const ids = obj['selected_situations'] ?? obj['ids'] ?? obj['selected'];
    if (!Array.isArray(ids)) return all.slice(0, maxCount);

    const selected: ExpressionEntry[] = [];
    for (const idx of ids) {
      const i = typeof idx === 'number' ? idx : parseInt(String(idx), 10);
      if (Number.isFinite(i) && i >= 0 && i < all.length && selected.length < maxCount) {
        selected.push(all[i]!);
      }
    }
    return selected.length > 0 ? selected : all.slice(0, maxCount);
  } catch (err) {
    logger.debug({ err, chatId }, 'expression-selector LLM failed, using top-by-count');
    return all.slice(0, maxCount);
  }
}
