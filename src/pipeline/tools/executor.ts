// ────────────────────────────────────────
// Tool-aware reply generator
// Uses Vercel AI SDK generateText with tools
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { buildToolSet } from './registry.js';
import { getUsage, getLabel } from '../../ai/labels.js';
import { logger } from '../../shared/logger.js';
import type { AICallResult } from '../../ai/types.js';

const MAX_TOOL_STEPS = 3;
const TOOL_TIMEOUT_MS = 30_000;

export async function generateWithTools(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  chatId: number,
  userId: number,
  usage: string,
  opts?: { temperatureOverride?: number },
): Promise<AICallResult & { toolsUsed: string[] }> {
  const start = performance.now();
  const usageConfig = getUsage(usage);
  const label = getLabel(usageConfig.label);
  const tools = buildToolSet(chatId, userId);

  const apiKey = label.apiKeys[Math.floor(Math.random() * label.apiKeys.length)];
  const provider = createOpenAI({
    baseURL: label.endpoint,
    apiKey,
  });

  const result = await generateText({
    model: provider(label.model),
    messages,
    tools,
    maxSteps: MAX_TOOL_STEPS,
    maxTokens: usageConfig.maxTokens,
    temperature: opts?.temperatureOverride ?? usageConfig.temperature,
    abortSignal: AbortSignal.timeout(usageConfig.timeout ?? TOOL_TIMEOUT_MS),
  });

  const latencyMs = Math.round(performance.now() - start);

  // Collect which tools were used
  const toolsUsed: string[] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      toolsUsed.push(call.toolName);
    }
  }

  if (toolsUsed.length > 0) {
    logger.info({ chatId, toolsUsed, latencyMs }, 'Tools executed');
  }

  return {
    content: result.text,
    tokenUsage: {
      prompt: result.usage?.promptTokens ?? 0,
      completion: result.usage?.completionTokens ?? 0,
      total: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
    },
    model: label.model,
    label: label.name,
    latencyMs,
    toolsUsed,
  };
}
