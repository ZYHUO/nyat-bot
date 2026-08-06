import type { AttentionLayer } from './types.js';

export interface AttentionLayerDecision {
  layer: AttentionLayer;
  reason: string;
  pressureBoost?: number;
}

/**
 * Classify Attention layer for Meta ingress.
 * 纯 LLM 驱动原则 (2026-08-06)：不再用正则猜测"这是不是问题"——
 * 被动消息一律 L2，由 Heart LLM 决定是否插话（Heart 已接管"该不该回"）。
 *
 * 只保留**协议性**判定（不可由 LLM 替代的事实）：
 * L0: DM / @ / reply-to-bot / nickname direct（Telegram 协议语义）
 * L2: 其余一切被动消息（交给 Heart / Meta LLM）
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

  // 被动消息：不猜意图，统一 L2 → Heart LLM 决定插话与否。
  return { layer: 'L2', reason: 'passive' };
}
