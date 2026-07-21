import type { AttentionLayer } from './types.js';

export interface AttentionLayerDecision {
  layer: AttentionLayer;
  reason: string;
  /** Boost pressure slightly for elevated L1. */
  pressureBoost?: number;
}

const QUESTION_MARK = /[?？]/;
// Cheap Chinese/English question cues (no LLM).
const QUESTION_CUES =
  /^(?:谁|哪|哪[里兒儿]|什么|什麼|咋|怎么|怎麼|为何|為何|为什么|為什麼|几|幾|多少|能否|可不可以|可以吗|可以嗎|有没有|有沒有|是不是|对不对|對不對|吗|嗎|呢)\b|(?:吗|嗎|呢|啥|么|麼)\s*$|^(?:who|what|where|when|why|how|is|are|can|could|do|does|did)\b/i;

/**
 * Classify Attention layer for Meta ingress.
 * L0: DM / @ / reply-to-bot / nickname direct
 * L1: passive but looks like a question aimed at the room (elevated)
 * L2: other passive
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

  const text = (opts.text || '').trim();
  if (text.length >= 2 && text.length <= 120) {
    const looksQuestion =
      QUESTION_MARK.test(text) || QUESTION_CUES.test(text.replace(/^@\S+\s*/, ''));
    // Short imperative / bot-directed without @ (「来一下」「帮看下」)
    const softAsk =
      /^(?:帮|幫|求|麻烦|麻煩|拜托|拜託|来|來|请问|請問)/.test(text) ||
      /(?:告诉我|告訴我|解释|解釋|看看|看下|帮忙|幫忙)/.test(text);
    if (looksQuestion || softAsk) {
      return {
        layer: 'L1',
        reason: looksQuestion ? 'passive_question' : 'passive_soft_ask',
        pressureBoost: 15,
      };
    }
  }

  return { layer: 'L2', reason: 'passive' };
}
