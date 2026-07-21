import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, ephemeralText, volatileText, deltaText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import type { DispatchTask } from '../meta/types.js';
import { createHostApi, type HostApi } from './host-api.js';
import { randomUUID } from 'node:crypto';

const EXECUTOR_SYSTEM = `你是啾咪囝(@hunhebi_bot)的 Subagent。你在群/私聊里用 CodeAct：写 JavaScript 调用 host API 行动。

人格要点：自称「本喵」；短句利落；嘴硬心软；不说「…是吧/对吧」；不是客服。

可用全局对象:
- telegram.sendText(text, replyToMessageId?)
- telegram.sendSticker(fileId)
- telegram.react(messageId, emoji)
- memory.search(query)
- memory.recallPerson(uid, query)  // 以人为中心跨上下文
- memory.recentContext(limit?)
- stickers.pick(mood?)  // 返回 fileId 或 null
- runtime.endTask(summary)  // 必须在结束时调用
- console.log(...)

规则:
1. 先读 memory.recentContext() 再说话（除非 direction 说可以立刻回）。
2. 默认用 telegram.sendText 回复；合适再 stickers.pick + sendSticker。
3. replyTo 优先用任务里的 quote / 锚点 messageId。
4. 输出：思考 + 一个 \`\`\`js 代码块。可多轮；每轮一块。
5. 完成后调用 runtime.endTask("一句话摘要")。
6. contentDirection 是方向不是台词——用自己的猫娘口吻写。`;

function extractJs(text: string): string | null {
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

async function runHostCode(code: string, host: HostApi): Promise<{ ok: boolean; output: string }> {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction(
      'telegram',
      'memory',
      'stickers',
      'runtime',
      'console',
      `"use strict";\n${code}`,
    );
    const out = await Promise.race([
      fn(host.telegram, host.memory, host.stickers, host.runtime, console),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('codeact_timeout')), env().CODEACT_TIMEOUT_MS),
      ),
    ]);
    return {
      ok: true,
      output: out === undefined ? 'ok' : typeof out === 'string' ? out : JSON.stringify(out),
    };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

const queue: DispatchTask[] = [];
let draining = false;

export function enqueueSubagentTask(task: DispatchTask): void {
  queue.push(task);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const task = queue.shift()!;
      await runCodeActTask(task);
    }
  } finally {
    draining = false;
  }
}

export async function runCodeActTask(task: DispatchTask): Promise<void> {
  const state = getGlobalState();
  task.status = 'running';
  state.putTask(task);

  let endSummary = '';
  let ended = false;
  const host = createHostApi(task.chatId, {
    defaultReplyTo: task.quoteMessageIds?.[0],
    onEnd: (summary) => {
      ended = true;
      endSummary = summary;
    },
  });

  const engine = getContextEngine(`subagent:${task.chatId}`);
  let dreaming = '';
  try {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    dreaming = await readFile(resolve('prompts/meta/background-dreaming.md'), 'utf8');
  } catch { /* optional */ }
  let journal = '';
  try {
    const { readRecentDreamSnippet } = await import('../cron/dream-journal.js');
    journal = (await readRecentDreamSnippet(300)) ?? '';
  } catch { /* optional */ }

  const { prompt, manifest } = await engine.assemble([
    staticText('sub-system', EXECUTOR_SYSTEM),
    staticText('sub-persona-direction', dreaming || '（无人设方向文件）'),
    deltaText(
      'sub-direction',
      `## Task\nchatId=${task.chatId}\ncontentDirection=${task.contentDirection}` +
        (task.toneGuidance ? `\ntoneGuidance=${task.toneGuidance}` : '') +
        (task.quoteMessageIds?.length ? `\nquotes=${task.quoteMessageIds.join(',')}` : ''),
    ),
    ephemeralText('sub-banned', `## Banned substrings\n${env().CODEACT_BANNED_WORDS.join(', ')}`),
    ephemeralText('sub-journal', journal ? `## Recent diary snippet\n${journal}` : ''),
    volatileText('sub-now', `## Now\n${new Date().toISOString()}\nBegin.`),
  ]);

  logger.info(
    {
      taskId: task.id,
      chatId: task.chatId,
      cacheHitRatio: Number(manifest.cacheHitRatio.toFixed(3)),
    },
    'CodeAct task start',
  );

  const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: '执行任务。先 recentContext，再按 direction 回复，最后 runtime.endTask。',
    },
  ];

  const maxTurns = env().CODEACT_MAX_TURNS;
  for (let turn = 0; turn < maxTurns && !ended; turn++) {
    let llmText = '';
    try {
      const result = await callWithFallback({
        usage: env().CODEACT_USAGE,
        messages: history,
        maxTokens: 1500,
        temperature: 0.7,
      });
      llmText = result.content ?? '';
    } catch (err) {
      logger.warn({ err, taskId: task.id, turn }, 'CodeAct LLM failed');
      break;
    }

    history.push({ role: 'assistant', content: llmText });
    const code = extractJs(llmText);
    if (!code) {
      history.push({
        role: 'user',
        content: '请用 ```js 代码块调用 API；完成后 runtime.endTask。',
      });
      continue;
    }

    const exec = await runHostCode(code, host);
    history.push({
      role: 'user',
      content: exec.ok
        ? `[observation]\n${exec.output}\n${ended ? '(task ended)' : '继续或 endTask。'}`
        : `[observation:error]\n${exec.output}\n修正后重试或换策略，仍要 endTask。`,
    });
  }

  if (!ended) {
    // Failsafe: one plain reply so L0 never silent-swallows
    try {
      const ctx = await host.memory.recentContext(8);
      const fallback = await callWithFallback({
        usage: env().CODEACT_USAGE,
        messages: [
          {
            role: 'system',
            content:
              '你是啾咪囝，短句猫娘。根据方向写一句回复纯文本，不要 JSON，不要代码。',
          },
          {
            role: 'user',
            content: `direction: ${task.contentDirection}\ncontext:\n${ctx.slice(0, 1500)}`,
          },
        ],
        maxTokens: 200,
        temperature: 0.8,
      });
      const text = (fallback.content ?? '').trim().slice(0, 500);
      if (text) await host.telegram.sendText(text);
      endSummary = 'fallback_plain_reply';
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'CodeAct failsafe reply failed');
      endSummary = 'failed_silent';
    }
  }

  task.status = endSummary.startsWith('failed') ? 'failed' : 'done';
  task.resultSummary = endSummary || 'done';
  state.putTask(task);
  state.enqueueCallback({
    id: randomUUID(),
    taskId: task.id,
    chatId: task.chatId,
    summary: task.resultSummary,
    ok: task.status === 'done',
    createdAt: Date.now(),
  });
  logger.info({ taskId: task.id, status: task.status, summary: task.resultSummary }, 'CodeAct task done');
}

/** Test helper */
export function _resetSubagentQueue(): void {
  queue.length = 0;
  draining = false;
}
