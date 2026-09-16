import { callWithFallback } from '../ai/fallback.js';
import { loadCachedPrompt } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import {
  queryJargon,
  searchJargons,
  markJargonInferred,
  markJargonNoInfo,
} from './jargon-miner.js';
import type { JargonEntry, JargonInferResult } from './types.js';

// At/above this tier the jargon is well-established; subsample raw_samples to
// roughly half to cap inference token cost on large sample sets. tunable
const HIGH_THRESHOLD = 25; // tunable
const HIGH_SAMPLE_RATIO = 0.5; // tunable

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
      if (!Array.isArray(arr)) return '';
      // At high tiers there are many samples; subsample ~50% (capped at 5) to
      // refine the meaning without blowing up the token budget. At lower tiers
      // keep the original behaviour of taking the first few.
      if (entry.count >= HIGH_THRESHOLD) {
        const keep = Math.max(1, Math.min(5, Math.ceil(arr.length * HIGH_SAMPLE_RATIO)));
        return arr.slice(0, keep).join('\n');
      }
      return arr.slice(0, 5).join('\n');
    } catch {
      return typeof entry.raw_samples === 'string' ? entry.raw_samples : '';
    }
  })();

  // Extend the existing prompt's INPUTS with a previous-understanding section so
  // higher tiers refine rather than re-derive the meaning from scratch.
  const prevMeaning = typeof entry.meaning === 'string' ? entry.meaning.trim() : '';
  const refineBlock = prevMeaning
    ? `\n\n先前理解（请在此基础上校正/补充，如已准确可保留）：\n${prevMeaning}`
    : '';

  const userContent = samples
    ? `词条：${entry.content}\n\n出现上下文：\n${samples}${refineBlock}`
    : `词条：${entry.content}${refineBlock}`;

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
  } else {
    // No usable meaning at this tier: advance the tier marker without
    // overwriting any previously inferred meaning, so we won't retry here.
    markJargonNoInfo(entry.chat_id, entry.content);
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
