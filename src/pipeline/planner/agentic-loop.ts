// ────────────────────────────────────────
// Agentic Planner Loop — MaiBot 1.0.0 Maisaka borrow
// ────────────────────────────────────────
// 多轮 plan→act:用 AI SDK generateText({tools, maxSteps}) 跑原生工具循环,
// 工具结果以 ToolResultMessage 回写 LLM 历史,模型可以自适应换工具/组合
// 查询/判断不需要工具直接收尾(对应 MaiBot reasoning_engine 内层 round
// 循环)。替代旧「一次 JSON 计划 → 批量执行」:旧路径第一个工具空手而归
// 时只能硬着头皮写"没查到"。
// 终止条件:模型某一步不再发工具调用(AI SDK 内置,即 MaiBot
// PLANNER_NO_TOOL_FINISH 语义)或达到 PLANNER_MAX_STEPS 上限。
// 失败回退:任何错误返回 failed=true,调用方退回旧 planReply 路径——
// agentic 是增强,不是单点。

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { getUsage, getLabel } from '../../ai/labels.js';
import { CooldownTracker } from '../../ai/cooldown.js';
import { getRedis } from '../../db/redis.js';
import { buildToolSet } from '../tools/registry.js';
import { loadPrompt, getConfig } from '../../shared/config.js';
import { mergeAbortSignals, isCallerAbort } from '../../shared/abort.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export interface AgenticPlanResult {
  /** 给最终 writer 的 [TOOL_RESULTS] 文本块;没用工具则 undefined */
  toolResultsBlock?: string;
  toolsUsed: string[];
  steps: number;
  failed: boolean;
}

export interface AgenticPlanInput {
  messageText: string;
  context: string;
  knowledge?: string;
  chatId: number;
  userId: number;
  /** turn-actor 打断信号:循环中途被打断时随 AbortError 浮出 */
  signal?: AbortSignal;
  /** 工具子集白名单(多智能体专家用);undefined = 全部工具(旧行为)。 */
  toolFilter?: string[];
  /** 覆盖 maxSteps(多智能体专家自定预算);undefined = 用 PLANNER_MAX_STEPS。 */
  maxStepsOverride?: number;
}

function buildUserPrompt(input: AgenticPlanInput): string {
  const sections: string[] = [];
  if (input.knowledge?.trim()) sections.push(`[KNOWLEDGE]\n${input.knowledge.trim()}`);
  sections.push(`[CURRENT_MESSAGE]\n${input.messageText || '[空消息]'}`);
  sections.push(`[CONTEXT]\n${input.context || '[无上下文]'}`);
  return sections.join('\n\n');
}

export async function runAgenticPlanner(input: AgenticPlanInput): Promise<AgenticPlanResult> {
  const e = env();
  const config = getConfig();
  const usage = getUsage('planner');
  const systemPrompt = loadPrompt('task/planner-agentic.md', config.promptsDir);
  const tools = buildToolSet(input.chatId, input.userId, input.toolFilter);
  const start = performance.now();

  // 简化版 fallback:按 usage 的 label 链逐个试(agentic 必须走 AI SDK
  // 原生 tool use,不能复用 callWithFallback 的纯文本管线)。cooldown
  // 与 callWithFallback 共享同一 Redis 视角:429 冷却中的 label 跳过,
  // 失败 429 时也写回冷却 —— 两条路径对 label 健康的认知保持一致。
  const labelNames = [usage.label, ...usage.backups];
  const cooldown = new CooldownTracker(getRedis());
  let lastErr: unknown;
  for (const labelName of labelNames) {
    const label = getLabel(labelName);
    const apiKey = label.apiKeys[0];
    if (!apiKey || label.apiFormat === 'claude') continue; // claude 原生格式标签跳过
    if (await cooldown.isCoolingDown(label.model).catch(() => false)) {
      logger.debug({ label: labelName, model: label.model }, 'Agentic planner skipping cooled-down label');
      continue;
    }

    try {
      const provider = createOpenAI({
        baseURL: label.endpoint,
        apiKey,
        compatibility: 'compatible',
      });
      const result = await generateText({
        // structuredOutputs:false → 工具不带 strict:true。strict 模式要求
        // required 含全部 key,带可选参数的工具(FETCH_HISTORY/ADD_TIMER)
        // 会被 OpenAI 端 400(冒烟实测);zod 在执行侧已兜底校验。
        model: provider(label.model, { structuredOutputs: false }),
        system: systemPrompt,
        messages: [{ role: 'user', content: buildUserPrompt(input) }],
        tools,
        maxSteps: input.maxStepsOverride ?? e.PLANNER_MAX_STEPS,
        temperature: 0,
        abortSignal: mergeAbortSignals(usage.timeout, input.signal),
      });

      const toolsUsed: string[] = [];
      const blocks: string[] = [];
      let stepIdx = 0;
      for (const step of result.steps) {
        // Record<string, Tool> 泛型下 SDK 推不出 result 具体类型 — 手动收窄
        const stepResults = step.toolResults as unknown as Array<{ toolName: string; result: unknown }>;
        for (let i = 0; i < step.toolCalls.length; i++) {
          const call = step.toolCalls[i]!;
          const res = stepResults[i];
          toolsUsed.push(call.toolName);
          stepIdx++;
          const rendered =
            res === undefined
              ? '(no result)'
              : typeof res.result === 'string'
                ? res.result
                : JSON.stringify(res.result, null, 2);
          blocks.push(
            [
              `Step ${stepIdx}`,
              `tool: ${call.toolName}`,
              `args: ${JSON.stringify(call.args)}`,
              `output:\n${rendered}`,
            ].join('\n'),
          );
        }
      }

      logger.info(
        {
          chatId: input.chatId,
          rounds: result.steps.length,
          toolsUsed,
          label: labelName,
          latencyMs: Math.round(performance.now() - start),
        },
        'Agentic planner loop finished',
      );

      return {
        toolResultsBlock: blocks.length > 0 ? `[TOOL_RESULTS]\n${blocks.join('\n\n')}` : undefined,
        toolsUsed,
        steps: result.steps.length,
        failed: false,
      };
    } catch (err) {
      lastErr = err;
      // 外部打断(turn interrupt)直接上抛,让 replan 机制接手
      if (isCallerAbort(input.signal)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
        await cooldown.setCooldown(label.model).catch(() => {});
      }
      logger.warn({ err, label: labelName, chatId: input.chatId }, 'Agentic planner label failed, trying next');
    }
  }

  logger.warn({ err: lastErr, chatId: input.chatId }, 'Agentic planner exhausted labels, falling back to legacy');
  return { toolsUsed: [], steps: 0, failed: true };
}
