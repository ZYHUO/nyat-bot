import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, deltaText, ephemeralText, volatileText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from './global-state.js';
import { buildMetaApiContext } from './meta-api.js';
import type { AttentionItem, SubagentCallback } from './types.js';
import { isMetaSubagentChat } from './flags.js';

const META_SYSTEM = `你是啾咪囝的 Meta Agent（全局编排大脑）。你不直接发群消息。
你通过写 JavaScript 调用沙盒 API 做决策：

可用全局对象（已注入）:
- dispatch.taskToGroup(chatId, { contentDirection, toneGuidance?, quotes?, trackingKey? })
- dispatch.getTask(taskId) / dispatch.listTasks(chatId?)
- todo.add(text) / todo.list() / todo.remove(id)
- agents.listStatus()
- conversations.query(hint)
- memory.searchEntities(query)
- console.log(...)

规则:
1. contentDirection 只写「要做什么/回什么事实方向」，不要写具体台词（台词由 Subagent 生成）。
2. L0（@/私聊/直接互动）通常应立刻 dispatch。
3. L2（旁观话题）可以不行动；要插嘴才 dispatch。
4. 回调(callback)先读摘要，再决定是否跟进 dispatch。
5. 结束前在思考里用 [SESSION_DIGEST]...[/SESSION_DIGEST] 写一句本轮摘要。
6. 输出格式：先简短思考，再给出一个 \`\`\`js 代码块。
7. 保持短句决策；你是猫娘人格的调度者，不是客服工单系统。`;

async function loadBackgroundDreaming(): Promise<string> {
  try {
    return await readFile(resolve('prompts/meta/background-dreaming.md'), 'utf8');
  } catch {
    return '';
  }
}

function extractJsBlock(text: string): string | null {
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

function extractDigest(text: string): string | null {
  const m = text.match(/\[SESSION_DIGEST\]([\s\S]*?)\[\/SESSION_DIGEST\]/i);
  return m?.[1]?.trim() || null;
}

async function runMetaCode(code: string): Promise<void> {
  const api = buildMetaApiContext();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction(...Object.keys(api), 'console', `"use strict";\n${code}`);
  await Promise.race([
    fn(...Object.values(api), console),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('meta_code_timeout')), env().CODEACT_TIMEOUT_MS),
    ),
  ]);
}

async function autoDispatchL0(attention: AttentionItem[]): Promise<void> {
  const api = buildMetaApiContext();
  const d = api['dispatch'] as {
    taskToGroup: (
      chatId: number,
      args: { contentDirection: string; quotes?: number[] },
    ) => Promise<unknown>;
  };
  for (const a of attention.filter((x) => x.layer === 'L0')) {
    if (!isMetaSubagentChat(a.chatId)) continue;
    await d.taskToGroup(a.chatId, {
      contentDirection: `直接回复用户消息 #${a.messageId ?? ''}：${a.textPreview ?? a.reason}`,
      quotes: a.messageId ? [a.messageId] : undefined,
    });
  }
}

export async function runMetaSession(
  attention: AttentionItem[],
  callbacks: SubagentCallback[],
): Promise<{ digest: string | null; codeRan: boolean }> {
  if (attention.length === 0 && callbacks.length === 0) {
    return { digest: null, codeRan: false };
  }

  const state = getGlobalState();
  const engine = getContextEngine('meta');
  const dreaming = await loadBackgroundDreaming();

  const attentionBlock = attention
    .map(
      (a) =>
        `- [${a.layer} p=${a.pressure}] chat=${a.chatId} msg=${a.messageId ?? '-'} uid=${a.userId ?? '-'} reason=${a.reason}` +
        (a.textPreview ? ` text="${a.textPreview.slice(0, 120)}"` : ''),
    )
    .join('\n');

  const callbackBlock =
    callbacks.length === 0
      ? '(none)'
      : callbacks
          .map((c) => `- task=${c.taskId} chat=${c.chatId} ok=${c.ok} summary=${c.summary.slice(0, 200)}`)
          .join('\n');

  const digestBlock = state
    .recentDigests(6)
    .map((d) => `- ${new Date(d.at).toISOString()} ${d.text.slice(0, 160)}`)
    .join('\n');

  const { prompt, manifest } = await engine.assemble([
    staticText('meta-system', META_SYSTEM),
    staticText('meta-persona-direction', dreaming || '（无人设方向文件）'),
    deltaText('meta-digests', `## Recent session digests\n${digestBlock || '(none)'}`),
    ephemeralText('meta-attention', `## Attention set\n${attentionBlock || '(none)'}`),
    ephemeralText('meta-callbacks', `## Callbacks\n${callbackBlock}`),
    volatileText(
      'meta-now',
      `## Now\nISO=${new Date().toISOString()}\nWrite JS to dispatch if needed.`,
    ),
  ]);

  logger.info(
    {
      attention: attention.length,
      callbacks: callbacks.length,
      cacheHitRatio: Number(manifest.cacheHitRatio.toFixed(3)),
      totalChars: manifest.totalChars,
    },
    'Meta session start',
  );

  let result;
  try {
    result = await callWithFallback({
      usage: env().META_USAGE,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: '根据 Attention / Callbacks 做本轮编排。需要行动就写 js 代码块调用 dispatch。',
        },
      ],
      maxTokens: 1200,
      temperature: 0.3,
    });
  } catch (err) {
    logger.warn({ err }, 'Meta LLM failed');
    await autoDispatchL0(attention);
    return { digest: 'meta_llm_failed_auto_l0', codeRan: true };
  }

  const text = result.content ?? '';
  const code = extractJsBlock(text);
  let codeRan = false;
  let codeFailed = false;

  if (code) {
    try {
      await runMetaCode(code);
      codeRan = true;
    } catch (err) {
      codeFailed = true;
      logger.warn({ err }, 'Meta code exec failed');
    }
  }

  const hasL0 = attention.some((a) => a.layer === 'L0');
  if (hasL0 && (!codeRan || codeFailed)) {
    await autoDispatchL0(attention);
    codeRan = true;
  }

  const digest = extractDigest(text) ?? text.slice(0, 240);
  if (digest) {
    state.addDigest(digest);
    // Persist for dream-journal cron (may run same process; Redis survives restart)
    try {
      const { getRedis } = await import('../db/redis.js');
      const redis = getRedis();
      await redis.lpush('xxb:meta:digests', JSON.stringify({ at: Date.now(), text: digest.slice(0, 2000) }));
      await redis.ltrim('xxb:meta:digests', 0, 39);
    } catch {
      /* non-critical */
    }
  }
  return { digest, codeRan };
}
