import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';

export async function callAllowlistReviewModel(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  try {
    const result = await callWithFallback({
      usage: 'allowlist_review',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
    });
    return result.content;
  } catch (err) {
    logger.warn({ err }, 'Allowlist AI review call failed');
    return null;
  }
}
