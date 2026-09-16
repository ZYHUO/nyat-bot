// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent 人设一致性 Critic — 每条回复都查"有没有叫错主人/破人设/破关系"
// ─────────────────────────────────────────────────────────────────────────────
//
// 跟深度 Critic(查事实/跑题/语气,只 deep)分工:这个专攻人设/关系一致性,
// 全路由跑(每条回复都过)。堵"把主人叫成妹妹""对主人用错语气""破人设"类
// bug —— 正是之前出过的那类问题。有问题 → needsRewrite + feedback,编排器
// 回炉 1 次。fail-soft → 不回炉(用原草稿)。LLM 调用(judge 用量)。

import { callWithFallback } from '../../ai/fallback.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface PersonaCriticInput {
  messageText: string;
  draft: string;
  turnSignal?: AbortSignal;
}

export interface PersonaCriticVerdict {
  needsRewrite: boolean;
  feedback?: string;
}

export async function runPersonaCritic(input: PersonaCriticInput): Promise<PersonaCriticVerdict> {
  const e = env();
  const systemPrompt =
    '你是人设一致性二审。只查一件事:草稿有没有破人设/破关系 —— 把主人叫成别的称呼(妹妹/哥们等)、' +
    '对主人用错语气、人设前后矛盾、关系设定出错。不查事实、不查跑题(那是别的二审的活)。' +
    '没问题回 {"ok":true};有问题回 {"ok":false,"feedback":"具体怎么错了+怎么改(≤80字)"}。只输出 JSON。';
  const userMsg =
    `[对方的话]\n${input.messageText || '(空)'}\n\n[草稿]\n${input.draft}\n\n请只查人设/关系一致性。`;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 160,
      temperature: 0,
      signal: input.turnSignal,
      maxTimeoutMs: e.MULTI_AGENT_PERSONA_CRITIC_TIMEOUT_MS,
    });
    return parseVerdict(result.content ?? '');
  } catch (err) {
    logger.debug({ err }, 'Multi-agent persona-critic failed (non-critical)');
    return { needsRewrite: false };
  }
}

function parseVerdict(raw: string): PersonaCriticVerdict {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(m ? m[0] : cleaned) as Record<string, unknown>;
  } catch { /* kw 兜底 */ }
  if (!obj || typeof obj !== 'object') {
    const lower = cleaned.toLowerCase();
    if (lower.includes('ok') || lower.includes('通过')) return { needsRewrite: false };
    if (lower.includes('改') || lower.includes('错') || lower.includes('人设')) {
      return { needsRewrite: true, feedback: cleaned.slice(0, 120) };
    }
    return { needsRewrite: false };
  }
  if (obj['ok'] === true) return { needsRewrite: false };
  if (obj['ok'] === false) {
    const fb = typeof obj['feedback'] === 'string' ? (obj['feedback'] as string).slice(0, 160) : undefined;
    return { needsRewrite: true, feedback: fb };
  }
  return { needsRewrite: false };
}
