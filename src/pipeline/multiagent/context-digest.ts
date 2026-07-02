// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent 上下文理解专家 — 忙群先把最近 N 条 digest 成"现在在聊啥"
// ─────────────────────────────────────────────────────────────────────────────
//
// 忙群里写手上下文很长,重点被噪音淹没。本专家先把最近消息压成一句"现在在
// 聊什么、谁站哪边、当前气氛",写手拿精炼版(走 callOpt contextDigest)。
// 仅当最近消息数 ≥ MULTI_AGENT_CONTEXT_DIGEST_MIN_MSGS 才跑(闲聊短上下文不
// 浪费 token)。fail-soft → 不注入。LLM 调用(summarize 用量)。

import { callWithFallback } from '../../ai/fallback.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface ContextDigestInput {
  context: string;
  recentMsgCount: number;
  turnSignal?: AbortSignal;
}

/** 最近消息够多才 digest;否则返回 null(不烧 token)。 */
export async function runContextDigest(input: ContextDigestInput): Promise<string | null> {
  const e = env();
  if (input.recentMsgCount < e.MULTI_AGENT_CONTEXT_DIGEST_MIN_MSGS) return null;
  const ctx = (input.context ?? '').trim();
  if (ctx.length < 80) return null;
  const systemPrompt =
    '你是上下文理解器。把一串群聊压成一句"现在在聊什么"(≤60字):话题、谁在跟谁说、' +
    '当前气氛(激烈/轻松/吵架/冷场)。不要复述原文,要提炼。只输出这一句。';
  try {
    const result = await callWithFallback({
      usage: 'summarize',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: ctx },
      ],
      maxTokens: 100,
      temperature: 0.2,
      signal: input.turnSignal,
      maxTimeoutMs: e.MULTI_AGENT_CONTEXT_DIGEST_TIMEOUT_MS,
    });
    const text = (result.content ?? '').trim();
    if (!text) return null;
    return `[现在在聊] ${text}`;
  } catch (err) {
    logger.debug({ err }, 'Multi-agent context-digest failed (non-critical)');
    return null;
  }
}
