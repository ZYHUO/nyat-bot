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
import { acquireConcurrency, AI_MAX_CONCURRENCY_PER_ACCOUNT } from '../../ai/concurrency.js';
import { CooldownTracker } from '../../ai/cooldown.js';
import { getRedis } from '../../db/redis.js';
import { buildToolSet } from '../tools/registry.js';
import { mergeAbortSignals, isCallerAbort } from '../../shared/abort.js';
import { env } from '../../env.js';
import { incrCounter } from '../../metrics/registry.js';
import { logger } from '../../shared/logger.js';

export interface ReplyWithToolsInput {
  /** 完整消息数组(含 system 5 层人格 + user 上下文),与纯文本写手同源 */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | import('../../ai/types.js').ContentPart[] }>;
  usage: string;        // 'reply' / 'reply_pro' / ...
  chatId: number;
  userId: number;
  signal?: AbortSignal;
  temperature?: number;
  /** P3:工具白名单子集(direct 路径只给只读工具);不传 = 全量 */
  toolsOnly?: string[];
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
  // 见 labels.ts 的 reply_tools：这个写手只能走 OpenAI 兼容格式。
  const tools = buildToolSet(input.chatId, input.userId, input.toolsOnly);
  const maxSteps = Math.max(2, e.REPLY_TOOLS_MAX_STEPS);
  const start = performance.now();

  const labelNames = [usage.label, ...usage.backups];
  const cooldown = new CooldownTracker(getRedis());
  let lastErr: unknown;

  for (const labelName of labelNames) {
    const label = getLabel(labelName);
    const apiKey = label.apiKeys[0];
    if (!apiKey || label.apiFormat === 'claude') {
      // 跳过要记账：2026-09-21 实测 `Merged tool-writer exhausted` 193 次而
      // `label failed` **0 次**、`finished` **0 次**——即这个写手从来没成功过一次，
      // 而每次失败都没有任何一条 per-label 日志。原因是链上的 label 全被上面两个
      // 条件静默跳过（claude 格式 / 没 key / 在冷却），循环跑完直接落到 exhausted。
      // 没有这行账，193 次失败和"链在正常失败"在日志里长得一模一样。
      logger.debug(
        { label: labelName, model: label.model, hasKey: !!apiKey, apiFormat: label.apiFormat },
        !apiKey ? 'tool-writer: skip (no key)' : 'tool-writer: skip (claude format)',
      );
      incrCounter('reply_merged_writer_skipped_total', { label: labelName, reason: !apiKey ? 'no_key' : 'claude_format' });
      continue;
    }
    if (await cooldown.isCoolingDown(label.model).catch(() => false)) {
      logger.debug({ label: labelName, model: label.model }, 'tool-writer: skip (cooling)');
      incrCounter('reply_merged_writer_skipped_total', { label: labelName, reason: 'cooling' });
      continue;
    }
    // 客户端并发闸：这条路直接走 AI SDK 的 generateText，**不经过 callModel**，
    // 所以 round 81 加在 callModel 上的信号量拦不到它。round 93 实测：恢复后 17 分钟
    // stepfunvision（与 stepfun/judge/think/asi 共用同一账号）报 concurrency reached
    // 27 次、Circuit breaker tripped 61 次——闸装了，但这条路绕过去了。
    const release = await acquireConcurrency(
      `${label.endpoint}|${apiKey ?? ''}`, AI_MAX_CONCURRENCY_PER_ACCOUNT,
    );

    try {
      const provider = createOpenAI({ baseURL: label.endpoint, apiKey, compatibility: 'compatible' });
      const result = await generateText({
        // structuredOutputs:false → 工具不带 strict(可选参数工具会被 OpenAI 400)
        model: provider(label.model, { structuredOutputs: false }),
        messages: input.messages as Parameters<typeof generateText>[0]['messages'],
        tools,
        maxSteps,
        // round 6（新 goal）：**label.temperature 优先于一切**。
        //
        // 2026-09-22 线上实测：`/checkin` 走合并写手 → dshkimi 报
        //   `invalid temperature: only 1 is allowed for this model`
        // 9.66s 后 `Merged tool-writer exhausted labels, fall back to legacy`，
        // 用户等到 92 秒才收到回复（群里当场有人吐槽"一卡一卡的体验严重不行"）。
        //
        // 根因：这条路**不经过 callModel**（文件头注释写明"直接走 AI SDK 的
        // generateText"），所以 provider.ts 里三处 `label.temperature ?? opts.temperature`
        // 的强制覆盖拦不到它。而 `usage.temperature`（labels.ts 的 reply_tools 默认链）
        // 没配 temperature，于是落到 0.8 —— dshkimi（kimi-for-coding）只接受 1。
        //
        // `AI_PROVIDER_DSHKIMI_TEMPERATURE=1` 早就配了、label.temperature 也确实
        // 解析成 1（我验过），只是这条路径没读它。
        //
        // AILabel.temperature 的契约写的就是"per-label 强制覆盖(调用方显式值也让位)"，
        // 这里补上尊重。maxTokens 同样：label.maxTokens 优先（同契约）。
        maxTokens: label.maxTokens ?? usage.maxTokens,
        temperature: label.temperature ?? input.temperature ?? usage.temperature ?? 0.8,
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
    } finally {
      release();
    }
  }

  logger.warn({ err: lastErr, chatId: input.chatId }, 'Merged tool-writer exhausted labels, fall back to legacy');
  return { content: '', toolsUsed: [], failed: true, tokenUsage: { prompt: 0, completion: 0, total: 0 }, model: '', label: '', latencyMs: 0 };
}
