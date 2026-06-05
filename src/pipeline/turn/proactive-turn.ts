// ────────────────────────────────────────
// Turn Actor — G11 人格化主动发言生成
// ────────────────────────────────────────
//
// 旧 idle/proactive-scan 用 60-token 的临时 system prompt 直调 LLM,
// 和主回复人格完全断开 → 主动发言听起来像另一个机器人。
// 这里换成与 reactive 回复同一条 5 层人格管线(persona + 守则 + 契约 +
// 语气 + 任务),模型可用 {"action":"silent"} 表态"现在不想说"。
// cron 侧的资格判断、奖励门、间隔键、发送链保持不变 —— 只换生成。

import { getRecent } from '../context/manager.js';
import { slimContextForAI } from '../context/slim.js';
import { buildSystemPrompt } from '../reply/prompt-builder.js';
import { callWithFallback } from '../../ai/fallback.js';
import { parseReplyResponse } from '../reply/parser.js';
import { logger } from '../../shared/logger.js';

/**
 * Generate a proactive line with the FULL persona pipeline.
 * Returns null when the model declines (silent) or output is unusable.
 */
export async function generatePersonaProactiveText(
  chatId: number,
  botUid: number,
  intentBlock: string,
): Promise<string | null> {
  try {
    const recent = await getRecent(chatId, 15);
    if (recent.length === 0) return null;
    const current = recent.at(-1)!;
    const contextStr = slimContextForAI(recent.slice(0, -1), current, botUid);
    const systemPrompt = buildSystemPrompt('normal', undefined, chatId);

    const result = await callWithFallback({
      usage: 'reply',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            `[群聊上下文]\n${contextStr}\n\n${intentBlock}\n` +
            `没人在等你说话——这是你自己想不想开口的问题。不想说就输出 {"action":"silent"}。` +
            `要说的话最多 1 条短消息（不超过40字），自然随意,像真群友冒出来的一句。输出 JSON。`,
        },
      ],
      maxTokens: 200,
      temperature: 1.0,
    });

    const parsed = parseReplyResponse(result.content, current.messageId);
    if (parsed.some((p) => p.action === 'silent')) {
      logger.debug({ chatId }, 'Persona proactive: model declined (silent)');
      return null;
    }
    const text = parsed
      .filter((p) => !p.action || p.action === 'reply')
      .map((p) => p.replyContent.trim())
      .find((t) => t.length >= 2);
    if (!text) return null;
    return text.replace(/^["「『]|["」』]$/g, '').slice(0, 120);
  } catch (err) {
    logger.debug({ err, chatId }, 'generatePersonaProactiveText failed');
    return null;
  }
}
