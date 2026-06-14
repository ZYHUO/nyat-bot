// ────────────────────────────────────────
// Merged tool-bound writer — 一次调用 = 边想边调工具边出最终回复
// ────────────────────────────────────────
//
// 替代 "便宜 planner 跑工具循环出 [TOOL_RESULTS] → 贵写手再生成" 两段:
// 直接让写手(5 层人格 prompt)绑工具跑 generateText({tools, maxSteps}),
// 模型生成途中按需调工具,末步 result.text 就是 reply JSON。
//   - 无工具时 ≈ 纯文本写手速度(一步出 JSON)
//   - 有工具时省掉独立 planner 轮 + 省把完整上下文重发一遍
// 注意:写手 label 多带 reasoningEffort → 正常走 raw fetch 不支持 AI SDK
// 工具循环;这里强制走 createOpenAI 路径(工具回合丢 reasoning_effort,
// low 档影响很小)。失败回退由调用方退回老两段路径。

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { getUsage, getLabel } from '../../ai/labels.js';
import { CooldownTracker } from '../../ai/cooldown.js';
import { getRedis } from '../../db/redis.js';
import { buildToolSet } from '../tools/registry.js';
import { mergeAbortSignals, isCallerAbort } from '../../shared/abort.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface ReplyWithToolsInput {
  /** 完整消息数组(含 system 5 层人格 + user 上下文),与纯文本写手同源 */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  usage: string;        // 'reply' / 'reply_pro' / ...
  chatId: number;
  userId: number;
  signal?: AbortSignal;
  temperature?: number;
}

export interface ReplyWithToolsResult {
  content: string;      // 末步文本(reply JSON)
  toolsUsed: string[];
  failed: boolean;
  tokenUsage: { prompt: number; completion: number; total: number };
  model: string;
  label: string;
  latencyMs: number;
}

/**
 * 带工具的一次性写手。失败(label 全挂/工具循环异常)→ failed=true,
 * 调用方退回老的纯文本写手路径。外部打断(turn interrupt)上抛。
 */
export async function generateReplyWithTools(input: ReplyWithToolsInput): Promise<ReplyWithToolsResult> {
  const e = env();
  const usage = getUsage(input.usage);
  const tools = buildToolSet(input.chatId, input.userId);
  const maxSteps = Math.max(2, e.REPLY_TOOLS_MAX_STEPS);
  const start = performance.now();

  const labelNames = [usage.label, ...usage.backups];
  const cooldown = new CooldownTracker(getRedis());
  let lastErr: unknown;

  for (const labelName of labelNames) {
    const label = getLabel(labelName);
    const apiKey = label.apiKeys[0];
    if (!apiKey || label.apiFormat === 'claude') continue; // claude 原生格式跳过(AI SDK 工具走 openai 兼容)
    if (await cooldown.isCoolingDown(label.model).catch(() => false)) continue;

    try {
      const provider = createOpenAI({ baseURL: label.endpoint, apiKey, compatibility: 'compatible' });
      const result = await generateText({
        // structuredOutputs:false → 工具不带 strict(可选参数工具会被 OpenAI 400)
        model: provider(label.model, { structuredOutputs: false }),
        messages: input.messages as Parameters<typeof generateText>[0]['messages'],
        tools,
        maxSteps,
        maxTokens: usage.maxTokens,
        temperature: input.temperature ?? usage.temperature ?? 0.8,
        abortSignal: mergeAbortSignals(usage.timeout, input.signal),
      });

      const toolsUsed: string[] = [];
      for (const step of result.steps) {
        for (const call of step.toolCalls) toolsUsed.push(call.toolName);
      }
      const content = result.text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();

      const latencyMs = Math.round(performance.now() - start);
      logger.info(
        { chatId: input.chatId, steps: result.steps.length, toolsUsed, label: labelName, latencyMs },
        'Merged tool-writer finished',
      );
      return {
        content, toolsUsed, failed: false,
        tokenUsage: {
          prompt: result.usage?.promptTokens ?? 0,
          completion: result.usage?.completionTokens ?? 0,
          total: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
        },
        model: label.model, label: labelName, latencyMs,
      };
    } catch (err) {
      lastErr = err;
      if (isCallerAbort(input.signal)) throw err; // 打断上抛给 replan
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
        await cooldown.setCooldown(label.model).catch(() => {});
      }
      logger.warn({ err, label: labelName, chatId: input.chatId }, 'Merged tool-writer label failed, trying next');
    }
  }

  logger.warn({ err: lastErr, chatId: input.chatId }, 'Merged tool-writer exhausted labels, fall back to legacy');
  return { content: '', toolsUsed: [], failed: true, tokenUsage: { prompt: 0, completion: 0, total: 0 }, model: '', label: '', latencyMs: 0 };
}
