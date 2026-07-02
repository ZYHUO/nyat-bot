// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent 导演专家 — 写手前产出"情绪/姿态/切入点"块
// ─────────────────────────────────────────────────────────────────────────────
//
// heart 只给了 why(一句话念头),没给语气/切入。导演读上下文 + 念头,先定调:
// 这条该用什么情绪、什么姿态、从哪个角度切入。产出 [导演] 块喂写手(走独立
// callOpt directorHint)。全路由并行 fan-out,跟研究员/记忆员/人设员一起跑。
// fail-soft → 不注入(写手自己定调)。LLM 调用(judge 用量,轻)。

import { callWithFallback } from '../../ai/fallback.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface DirectorInput {
  messageText: string;
  context: string;
  heartWhy?: string;
  turnSignal?: AbortSignal;
}

/** 导演:产出情绪/姿态/切入点提示块。无产出 → null。 */
export async function runDirector(input: DirectorInput): Promise<string | null> {
  const e = env();
  const systemPrompt =
    '你是导演。给定对方的话、上下文、(可选)写手此刻的念头,你定这条回复的调:' +
    '用什么情绪(吐槽/温柔/兴奋/冷淡/撒娇…)、什么姿态(平等/长辈/捧场/拆台…)、从哪个角度切入。' +
    '输出 1-2 句,口语、具体、可执行(如"用拆台语气接他这个吹牛,从那个数字太离谱切入")。不要写正文。';
  const thoughtLine = input.heartWhy ? `\n[写手此刻念头] ${input.heartWhy}` : '';
  const userMsg = `[对方的话]\n${input.messageText || '(空)'}\n\n[上下文]\n${input.context || '(无)'}${thoughtLine}\n\n定调:`;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 120,
      temperature: 0.5,
      signal: input.turnSignal,
      maxTimeoutMs: e.MULTI_AGENT_DIRECTOR_TIMEOUT_MS,
    });
    const text = (result.content ?? '').trim();
    if (!text) return null;
    return `[导演定调] ${text}`;
  } catch (err) {
    logger.debug({ err }, 'Multi-agent director failed (non-critical)');
    return null;
  }
}
