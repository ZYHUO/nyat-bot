// ────────────────────────────────────────
// RECALL 工具 — 长期记忆语义检索(记忆员专家用)
// ────────────────────────────────────────
//
// 复用 searchMemory(Qdrant-backed,带硬超时)。记忆员用 agentic 循环驱动:
// LLM 决定"召回什么"(可多轮细化查询),比写手 retrieveContext 的一次性
// retrieveSemantic 更 directed。返回格式化片段供写手参考。

import { searchMemory } from '../../memory/chroma.js';

/**
 * 语义检索本群长期记忆,返回格式化片段。
 * @param chatId 群/私聊 id(记忆按 chat 隔离)
 * @param query  回忆关键词(人名/旧事/话题)
 * @param topK   召回条数(默认 8)
 */
export async function executeRecall(chatId: number, query: string, topK = 8): Promise<string> {
  const q = (query ?? '').trim();
  if (!q) return '没有回忆起相关旧对话(查询为空)。';
  const results = await searchMemory(chatId, q, topK, 800);
  if (results.length === 0) return `没有回忆起与"${q}"相关的旧对话。`;
  let out = `关于"${q}"的回忆(共 ${results.length} 条,按相关度):\n`;
  for (const m of results) {
    const who = m.fullName || m.username || '某人';
    const text = (m.textContent || m.captionContent || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    const date = new Date((m.timestamp ?? 0) * 1000).toISOString().slice(0, 10);
    const score = typeof m.score === 'number' ? ` (相关度${m.score.toFixed(2)})` : '';
    out += `- ${date} ${who}:${text}${score}\n`;
  }
  return out;
}
