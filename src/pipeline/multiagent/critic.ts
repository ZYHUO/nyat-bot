// ────────────────────────────────────────
// Multi-Agent Critic(Phase 4)— 草稿二审,不行回炉 1 次
// ────────────────────────────────────────
//
// 仅 deep 路径跑(写手出草稿后)。审事实/语气/跑题/未证实断言,有问题则给
// feedback,编排器带 feedback 重跑一次写手(+1 轮延迟换质量)。fail-soft →
// needsRewrite=false(不回炉,用原草稿)。

import { callWithFallback } from '../../ai/fallback.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface CriticInput {
  messageText: string;
  draft: string;
  findings?: string;
  turnSignal?: AbortSignal;
}

export interface CriticVerdict {
  needsRewrite: boolean;
  feedback?: string;
}

export async function runCritic(input: CriticInput): Promise<CriticVerdict> {
  const e = env();
  const systemPrompt =
    '你是二审。给定用户问题、素材、草稿,判断草稿是否:事实错误/跑题/语气不对/有未证实断言。' +
    '没问题回 {"ok":true};有问题回 {"ok":false,"feedback":"具体问题+怎么改(≤100字)"}。只输出 JSON。';
  const userMsg =
    `[用户问题]\n${input.messageText || '(空)'}\n\n[素材]\n${input.findings ?? '(无)'}\n\n[草稿]\n${input.draft}\n\n请二审。`;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 200,
      temperature: 0,
      signal: input.turnSignal,
      maxTimeoutMs: e.MULTI_AGENT_CRITIC_TIMEOUT_MS,
    });
    return parseCriticVerdict(result.content ?? '');
  } catch (err) {
    logger.debug({ err }, 'Multi-agent critic failed (non-critical)');
    return { needsRewrite: false };
  }
}

function parseCriticVerdict(raw: string): CriticVerdict {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(m ? m[0] : cleaned) as Record<string, unknown>;
  } catch { /* kw 兜底 */ }
  if (!obj || typeof obj !== 'object') {
    const lower = cleaned.toLowerCase();
    if (lower.includes('ok') || lower.includes('通过')) return { needsRewrite: false };
    if (lower.includes('改') || lower.includes('问题')) return { needsRewrite: true, feedback: cleaned.slice(0, 120) };
    return { needsRewrite: false };
  }
  if (obj['ok'] === true) return { needsRewrite: false };
  if (obj['ok'] === false) {
    const fb = typeof obj['feedback'] === 'string' ? (obj['feedback'] as string).slice(0, 200) : undefined;
    return { needsRewrite: true, feedback: fb };
  }
  return { needsRewrite: false };
}
