import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, ephemeralText, volatileText, deltaText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import type { DispatchTask } from '../meta/types.js';
import { createHostApi, type HostApi } from './host-api.js';
import { sendChatAction } from '../bot/sender/telegram.js';
import { randomUUID } from 'node:crypto';

/** Telegram typing 约 5s 过期；CodeAct 多轮期间持续刷新。 */
function startTypingHeartbeat(chatId: number): () => void {
  let stopped = false;
  const pulse = () => {
    if (stopped) return;
    void sendChatAction(chatId, 'typing');
  };
  pulse();
  const timer = setInterval(pulse, 4000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

const EXECUTOR_SYSTEM = `你是啾咪囝(@hunhebi_bot)的 Subagent。用 CodeAct：写 JavaScript 调用 host API 行动。

人格与说话方式见下方完整人格层（persona/tone/reply）——必须遵守，尤其是「短、像发微信」。

可用全局对象:
- telegram.sendText(text, replyToMessageId?)
- telegram.sendSticker(fileId)
- telegram.react(messageId, emoji)
- memory.search(query)
- memory.recallPerson(uid, query)
- memory.recentContext(limit?)
- stickers.pick(mood?)
- runtime.endTask(summary)  // 必须在结束时调用
- console.log(...)

规则:
1. 下方已注入最近聊天；需要再查再调 memory.*。
2. 默认 telegram.sendText(text) —— **不要省略**；系统会自动 reply 到任务 quotes 锚点。若手动传 replyTo，必须用 quotes 里的 messageId。
3. 群聊微反应；禁止小作文。
4. 输出：极短思考 + 一个 \`\`\`js 代码块。可多轮。
5. 完成后 runtime.endTask("一句话摘要")。
6. contentDirection 是方向不是台词——用本喵口吻短写。`;

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

  // 与 legacy reply 同源人格层（此前 CodeAct 只有几句摘要 → 话多、不像本喵）
  const { buildCodeActIdentityPrompt } = await import('../pipeline/reply/prompt-builder.js');
  const identity = buildCodeActIdentityPrompt();

  let recentCtx = '';
  try {
    recentCtx = await host.memory.recentContext(30);
  } catch { /* optional */ }

  let permanent = '';
  try {
    const { loadCachedPrompt } = await import('../shared/config.js');
    permanent = loadCachedPrompt('knowledge/permanent.md').slice(0, 1200);
  } catch { /* optional */ }

  const { prompt, manifest } = await engine.assemble([
    staticText('sub-system', EXECUTOR_SYSTEM),
    staticText('sub-identity', identity),
    staticText('sub-persona-direction', dreaming || '（无人设方向文件）'),
    ephemeralText('sub-permanent', permanent ? `## 永久知识\n${permanent}` : ''),
    ephemeralText('sub-ctx', recentCtx ? `## 最近聊天\n${recentCtx}` : ''),
    deltaText(
      'sub-direction',
      `## Task\nchatId=${task.chatId}\ncontentDirection=${task.contentDirection}` +
        (task.toneGuidance ? `\ntoneGuidance=${task.toneGuidance}` : '') +
        (task.quoteMessageIds?.length ? `\nquotes=${task.quoteMessageIds.join(',')}` : '') +
        `\n\n硬提醒：短回。群聊微反应；别写小作文。`,
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

  const stopTyping = startTypingHeartbeat(task.chatId);
  try {
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
        const { buildCodeActIdentityPrompt } = await import('../pipeline/reply/prompt-builder.js');
        const fallback = await callWithFallback({
          usage: env().CODEACT_USAGE,
          messages: [
            {
              role: 'system',
              content:
                buildCodeActIdentityPrompt() +
                '\n\n现在只输出一句纯文本短回复，不要 JSON，不要代码。',
            },
            {
              role: 'user',
              content: `direction: ${task.contentDirection}\ncontext:\n${ctx.slice(0, 1500)}\n\n短回一句。`,
            },
          ],
          maxTokens: 120,
          temperature: 0.8,
        });
        const text = (fallback.content ?? '').trim().slice(0, 200);
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
    await state.enqueueCallbackAsync({
      id: randomUUID(),
      taskId: task.id,
      chatId: task.chatId,
      summary: task.resultSummary,
      ok: task.status === 'done',
      createdAt: Date.now(),
    });
  } finally {
    stopTyping();
  }
  logger.info({ taskId: task.id, status: task.status, summary: task.resultSummary }, 'CodeAct task done');
}

/** Test helper */
export function _resetSubagentQueue(): void {
  queue.length = 0;
  draining = false;
}
