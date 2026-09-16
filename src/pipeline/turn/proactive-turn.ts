// ────────────────────────────────────────
// Turn Actor — G11 人格化主动发言生成
// ────────────────────────────────────────
//
// 旧 idle/proactive-scan 用 60-token 的临时 system prompt 直调 LLM,
// 和主回复人格完全断开 → 主动发言听起来像另一个机器人。
// 这里换成与 reactive 回复同一条 5 层人格管线(persona + 守则 + 契约 +
// 语气 + 任务),模型可用 {"action":"silent"} 表态"现在不想说"。
// cron 侧的资格判断、奖励门、间隔键、发送链保持不变 —— 只换生成。
//
// P2-A: 记忆驱动 — 搜索 Qdrant 群聊记忆，注入"上次聊过的相关话题"
// P2-B: RSS 谈资 — 从 Redis 取最新 RSS 条目，作为可选谈资注入

import { getRecent } from '../context/manager.js';
import { slimContextForAI } from '../context/slim.js';
import { buildSystemPrompt } from '../reply/prompt-builder.js';
import { callWithFallback } from '../../ai/fallback.js';
import { parseReplyResponse, isBlankReply } from '../reply/parser.js';
import { logger } from '../../shared/logger.js';
import { env } from '../../env.js';
import { getRedis } from '../../db/redis.js';

/** 从最近消息提取搜索 query（拼接最近几条人类消息的文本） */
function buildMemoryQuery(
  recent: { textContent?: string; role: string; isBot?: boolean }[],
): string {
  const humanMsgs = recent
    .filter((m) => !m.isBot && m.role !== 'assistant' && m.textContent && m.textContent.trim())
    .slice(-5);
  return humanMsgs.map((m) => m.textContent!.slice(0, 60)).join(' ').slice(0, 200);
}

/** 格式化记忆条目为简短上下文 */
function formatMemoryHits(hits: { textContent: string; score?: number }[]): string {
  if (hits.length === 0) return '';
  const lines = hits.slice(0, 3).map((h, i) => {
    const text = h.textContent.slice(0, 80).replace(/\n/g, ' ');
    return `${i + 1}. ${text}`;
  });
  return `[相关记忆·之前聊过的事]\n${lines.join('\n')}\n\n`;
}

/** 从 Redis 取该群最新的 RSS 谈资条目 */
async function loadRssFuel(chatId: number): Promise<string> {
  if (!env().RSS_MONITOR_ENABLED) return '';
  try {
    const redis = getRedis();
    const items = await redis.lrange(`xxb:rss:fuel:${chatId}`, 0, 2);
    if (items.length === 0) return '';
    const parsed = items
      .map((s) => {
        try {
          return JSON.parse(s) as { title: string; source?: string };
        } catch {
          return null;
        }
      })
      .filter((x): x is { title: string; source?: string } => x !== null);
    if (parsed.length === 0) return '';
    const lines = parsed.map((f, i) => `${i + 1}. ${f.title}${f.source ? `(${f.source})` : ''}`);
    return `[可选谈资·刚看到的资讯]\n${lines.join('\n')}\n(可以提也可以不提，别硬塞)\n\n`;
  } catch {
    return '';
  }
}

/**
 * Generate a proactive line with the FULL persona pipeline.
 * Returns null when the model declines (silent) or output is unusable.
 *
 * P2-A: 自动搜索群聊记忆，注入"上次聊过的相关话题"作为上下文
 * P2-B: 自动加载 RSS 谈资，作为可选话题素材
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
    const systemPrompt = buildSystemPrompt(undefined, chatId);

    // P2-A: 记忆驱动 — 搜索 Qdrant 相关记忆
    let memoryBlock = '';
    if (env().PROACTIVE_MEMORY_ENABLED) {
      try {
        const { searchMemoryForInjection } = await import('../../memory/chroma.js');
        const query = buildMemoryQuery(recent);
        if (query.trim()) {
          const hits = await searchMemoryForInjection(chatId, query, 3, 500);
          memoryBlock = formatMemoryHits(
            hits.map((h) => ({ textContent: h.textContent, score: h.score })),
          );
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Proactive memory injection failed (non-critical)');
      }
    }

    // P2-B: RSS 谈资
    const rssBlock = await loadRssFuel(chatId);

    const result = await callWithFallback({
      usage: 'reply',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            `[群聊上下文]\n${contextStr}\n\n${memoryBlock}${rssBlock}${intentBlock}\n` +
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
      .find((t) => t.length >= 2 && !isBlankReply(t));
    if (!text) return null;
    return text.replace(/^["「『]|["」』]$/g, '').slice(0, 120);
  } catch (err) {
    logger.debug({ err, chatId }, 'generatePersonaProactiveText failed');
    return null;
  }
}
