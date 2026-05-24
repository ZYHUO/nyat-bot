import { callWithFallback } from '../ai/fallback.js';
import { loadCachedPrompt } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { queryJargon, searchJargons, markJargonInferred } from './jargon-miner.js';
import type { JargonEntry, JargonInferResult } from './types.js';

/**
 * Use LLM to infer the meaning of a jargon term.
 */
export async function inferJargonMeaning(
  entry: JargonEntry,
  usage: string,
): Promise<JargonInferResult> {
  let systemPrompt: string;
  try {
    systemPrompt = loadCachedPrompt('task/jargon-infer.md');
  } catch {
    return { meaning: '', no_info: true };
  }

  const samples = (() => {
    try {
      const arr = JSON.parse(entry.raw_samples);
      return Array.isArray(arr) ? arr.slice(0, 5).join('\n') : '';
    } catch {
      return typeof entry.raw_samples === 'string' ? entry.raw_samples : '';
    }
  })();

  const userContent = samples
    ? `词条：${entry.content}\n\n出现上下文：\n${samples}`
    : `词条：${entry.content}`;

  try {
    const result = await callWithFallback({
      usage,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      maxTokens: 200,
      temperature: 0,
    });

    const raw = result.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { meaning: '', no_info: true };

    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      meaning: typeof obj['meaning'] === 'string' ? obj['meaning'] : '',
      no_info: obj['no_info'] === true,
    };
  } catch (err) {
    logger.debug({ err, content: entry.content }, 'jargon inference failed');
    return { meaning: '', no_info: true };
  }
}

/**
 * Run inference on a jargon entry and persist result.
 */
export async function inferAndPersist(entry: JargonEntry, usage: string): Promise<void> {
  const result = await inferJargonMeaning(entry, usage);
  if (!result.no_info && result.meaning) {
    markJargonInferred(entry.chat_id, entry.content, result.meaning);
  }
}

/**
 * Query jargon meaning for the bot's QUERY_JARGON skill.
 * Returns a human-readable explanation or "unknown".
 */
export function explainJargon(chatId: number, term: string): string {
  const exact = queryJargon(chatId, term);
  if (exact && exact.meaning) {
    return `「${term}」：${exact.meaning}`;
  }

  const fuzzy = searchJargons(chatId, term);
  if (fuzzy.length > 0) {
    return fuzzy.map((j) => `「${j.content}」：${j.meaning}`).join('\n');
  }

  return `未找到「${term}」的含义记录。`;
}
