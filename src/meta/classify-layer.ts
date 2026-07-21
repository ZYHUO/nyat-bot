import type { AttentionLayer } from './types.js';

export interface AttentionLayerDecision {
  layer: AttentionLayer;
  reason: string;
  pressureBoost?: number;
}

const QUESTION_MARK = /[?？]/;
// Strict question cues — avoid bare 吗/呢 (too common in casual chatter).
// No \b after CJK (JS word-boundary is ASCII-oriented).
const QUESTION_CUES =
  /(?:谁|哪个|哪[里兒儿]|什么|什麼|咋|怎么|怎麼|为何|為何|为什么|為什麼|几|幾|多少|有没有|有沒有|是不是)|^(?:who|what|where|when|why|how)\b/i;

/**
 * Classify Attention layer for Meta ingress.
 * L0: DM / @ / reply-to-bot / nickname direct
 * L1: rare — clear question marks / interrogatives only (not soft 吗-chatter)
 * L2: passive (Meta must default to silence)
 */
export function classifyAttentionLayer(opts: {
  chatId: number;
  isDirect: boolean;
  directKind?: string | null;
  text: string;
}): AttentionLayerDecision {
  if (opts.chatId > 0) {
    return { layer: 'L0', reason: 'dm' };
  }
  if (opts.isDirect) {
    return {
      layer: 'L0',
      reason: opts.directKind ? `direct:${opts.directKind}` : 'direct',
    };
  }

  const text = (opts.text || '').trim().replace(/^@\S+\s*/, '');
  // Only elevate short, clear questions — Meta still decides; bar is high.
  if (text.length >= 4 && text.length <= 80 && QUESTION_MARK.test(text) && QUESTION_CUES.test(text)) {
    return {
      layer: 'L1',
      reason: 'passive_question',
      pressureBoost: 10,
    };
  }

  return { layer: 'L2', reason: 'passive' };
}
