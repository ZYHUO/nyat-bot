// 长时间 Agent 循环：上下文压缩（compaction）。
//
// 长任务 history 无限增长必然爆 token。超过阈值后，把早期轮次压成
// 结构化摘要（目标/已完成/关键发现/下一步/教训），保留最近 N 轮原文。
// 与 Hermes 的上下文压缩同款机制。

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import type { AgentCheckpoint } from './checkpoint.js';
import { logger } from '../shared/logger.js';

export interface CompactedHistory {
  /** 早期轮次的 LLM 摘要（含上一段 progressSummary 的合并）。 */
  summary: string;
  /** 保留的最近轮次原文。 */
  recent: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** 压缩后总轮数（摘要算 1 轮 + recent）。 */
  compactedTurns: number;
}

const RECENT_KEEP_TURNS = 16;

/**
 * 把 history 里除 system 外的早期轮次压成摘要。
 * 失败时降级：截断早期轮次（保留最近 RECENT_KEEP_TURNS 轮），不阻塞主链路。
 */
export async function compactHistory(
  cp: Pick<AgentCheckpoint, 'history' | 'progressSummary' | 'contentDirection'>,
): Promise<CompactedHistory> {
  const rest = cp.history.filter((m) => m.role !== 'system');

  if (rest.length <= RECENT_KEEP_TURNS) {
    return {
      summary: cp.progressSummary,
      recent: rest,
      compactedTurns: rest.length,
    };
  }

  const recent = rest.slice(-RECENT_KEEP_TURNS);
  const early = rest.slice(0, -RECENT_KEEP_TURNS);

  // 早期轮次转成给摘要模型的对话（去掉超长 observation，保留关键信息）。
  const earlyText = early
    .map((m) => {
      const c = m.content;
      const trimmed = c.length > 600 ? `${c.slice(0, 600)}…(截断)` : c;
      return `${m.role.toUpperCase()}: ${trimmed}`;
    })
    .join('\n')
    .slice(0, 24_000); // 摘要输入预算

  try {
    const result = await callWithFallback({
      usage: env().AGENT_COMPACT_USAGE,
      messages: [
        {
          role: 'system',
          content:
            '你是任务状态压缩器。把 agent 执行历史压成结构化摘要，供 agent 续跑时回忆。' +
            '严格输出 JSON：{"summary":"…","artifacts":["…"]}。' +
            'summary 必须包含：任务目标、已完成步骤、关键发现/产出、当前卡点、下一步计划、失败教训。' +
            '用中文，简洁但信息密度高，200-400 字。artifacts 列出已产出的文件/消息标识。',
        },
        {
          role: 'user',
          content: `任务方向：${cp.contentDirection}\n上一段进度：${cp.progressSummary || '(无)'}\n\n执行历史：\n${earlyText}`,
        },
      ],
      maxTokens: 800,
      temperature: 0.3,
    });

    const text = (result.content ?? '').trim();
    const json = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    let summary = cp.progressSummary;
    try {
      const parsed = JSON.parse(json) as { summary?: string; artifacts?: string[] };
      if (typeof parsed.summary === 'string' && parsed.summary.length > 20) {
        summary = `${cp.progressSummary ? `${cp.progressSummary}\n` : ''}${parsed.summary}`.slice(0, 3000);
      }
    } catch {
      // JSON 解析失败 —— 尝试裸文本
      if (text.length > 40) summary = `${cp.progressSummary ? `${cp.progressSummary}\n` : ''}${text}`.slice(0, 3000);
    }

    return { summary, recent, compactedTurns: recent.length + 1 };
  } catch (err) {
    logger.warn({ err }, 'agent compaction failed — truncating early turns');
    return {
      summary: cp.progressSummary,
      recent,
      compactedTurns: recent.length,
    };
  }
}

/**
 * 把压缩后的 checkpoint history 还原成可直接给 LLM 的 messages。
 * 结构：system(原 system) → user(压缩摘要块) → 最近轮次原文。
 */
export function restoreMessagesFromCompacted(
  cp: Pick<AgentCheckpoint, 'history' | 'progressSummary'>,
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  const system = cp.history.filter((m) => m.role === 'system');
  const rest = cp.history.filter((m) => m.role !== 'system');
  const recent = rest.slice(-RECENT_KEEP_TURNS);

  const summaryBlock =
    cp.progressSummary || rest.length > 0
      ? `[此前执行摘要]\n${cp.progressSummary || '(早期轮次已省略，以下从最近轮次继续)'}`
      : '';

  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [...system];
  if (summaryBlock) {
    messages.push({ role: 'user', content: summaryBlock });
    // 摘要块后给模型一个轻量确认位，保持对话结构连续。
    messages.push({ role: 'assistant', content: '[已回顾此前进度，继续。]' });
  }
  messages.push(...recent);
  return messages;
}
