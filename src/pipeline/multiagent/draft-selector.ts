// ─────────────────────────────────────────────────────────────────────────────
// Multi-Agent 草稿选择器 — Best-of-N:写手出 N 稿,挑最贴的发
// ─────────────────────────────────────────────────────────────────────────────
//
// 写手 token ×N 的出处。N 稿并行生成(同一份 prompt,模型自带多样性),选择器
// 读对方的话 + N 稿,挑最贴人设/最自然/最接梗的那条,返回索引。fail-soft →
// 返回 0(用第一稿,不阻塞)。LLM 调用(judge 用量,轻)。

import { callWithFallback } from '../../ai/fallback.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface DraftSelectorInput {
  messageText: string;
  drafts: string[];
  turnSignal?: AbortSignal;
}

/** 挑最优草稿索引;失败返回 0。 */
export async function selectBestDraft(input: DraftSelectorInput): Promise<number> {
  if (input.drafts.length <= 1) return 0;
  const e = env();
  const systemPrompt =
    '你是回复选择器。给定对方的话和若干候选回复,挑最贴人设(可爱猫娘)、最自然、最接话的那一条。' +
    '只输出一个数字:最优候选的编号(从 1 开始)。不要解释。';
  const list = input.drafts.map((d, i) => `候选${i + 1}:\n${d}`).join('\n\n');
  const userMsg = `[对方的话]\n${input.messageText || '(空)'}\n\n${list}\n\n最优候选编号:`;
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      maxTokens: 20,
      temperature: 0,
      signal: input.turnSignal,
      maxTimeoutMs: e.WRITER_SELECTOR_TIMEOUT_MS,
    });
    const m = (result.content ?? '').match(/(\d+)/);
    if (!m) return 0;
    const idx = parseInt(m[1]!, 10) - 1;
    if (idx < 0 || idx >= input.drafts.length) return 0;
    return idx;
  } catch (err) {
    logger.debug({ err }, 'Multi-agent draft-selector failed (non-critical)');
    return 0;
  }
}
