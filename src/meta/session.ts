import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, deltaText, ephemeralText, volatileText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from './global-state.js';
import { buildMetaApiContext } from './meta-api.js';
import type { AttentionItem, AttentionLayer, SubagentCallback } from './types.js';
import { isMetaSubagentChat } from './flags.js';

const META_SYSTEM = `你是啾咪囝的 Meta Agent（全局编排大脑）。你不直接发群消息。
你通过写 JavaScript 调用沙盒 API 做决策：

可用全局对象（已注入）:
- dispatch.taskToGroup(chatId, { contentDirection, toneGuidance?, quotes?, trackingKey?, interrupt? })
- dispatch.getTask(taskId) / dispatch.listTasks(chatId?)
- todo.add(text) / todo.list() / todo.remove(id)
- agents.listStatus()
- conversations.query(hint)
- memory.searchEntities(query)
- console.log(...)

规则:
1. contentDirection 只写「要做什么」的**短方向**（如「短回摸头」「短接梗」「傲娇拒绝」），不要写具体台词。
2. toneGuidance 常带「短、微信式、别展开」。
3. **L0**（@/私聊/回 bot）→ 应立刻 dispatch，且 **必须**带 quotes: [messageId]（Attention 里的 msg=）。
4. **L1**（旁观疑问）→ 多数沉默；只有明显想让你插嘴才 dispatch，同样必须 quotes。
5. **L2**（旁观闲聊）→ **默认不行动**。极少数神回复才可 dispatch，且必须 interrupt: true + quotes。
6. 同一 chat 一轮最多 dispatch 一次。
7. 回调(callback)先读摘要，再决定是否跟进。
8. 结束前用 [SESSION_DIGEST]...[/SESSION_DIGEST] 写一句摘要。
9. 输出：短思考 + 一个 \`\`\`js 代码块。你是调度者不是客服。`;

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

function buildAttentionMaps(attention: AttentionItem[]): {
  chatLayer: Map<number, AttentionLayer>;
  defaultQuotes: Map<number, number>;
} {
  const rank: Record<string, number> = { L0: 3, L1_CALLBACK: 2, L1: 2, L2: 1 };
  const chatLayer = new Map<number, AttentionLayer>();
  const defaultQuotes = new Map<number, number>();
  for (const a of attention) {
    const prev = chatLayer.get(a.chatId);
    if (!prev || (rank[a.layer] ?? 0) >= (rank[prev] ?? 0)) {
      chatLayer.set(a.chatId, a.layer);
    }
    if (a.messageId && a.messageId > 0) {
      // Prefer L0/L1 message ids over older L2
      const existing = defaultQuotes.get(a.chatId);
      if (!existing || a.layer === 'L0' || a.layer === 'L1') {
        defaultQuotes.set(a.chatId, a.messageId);
      }
    }
  }
  return { chatLayer, defaultQuotes };
}

async function runMetaCode(
  code: string,
  opts: {
    dispatchedChatIds: Set<number>;
    isAborted: () => boolean;
    chatLayer: Map<number, AttentionLayer>;
    defaultQuotes: Map<number, number>;
  },
): Promise<void> {
  const api = buildMetaApiContext(opts);
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

async function autoDispatchL0(
  attention: AttentionItem[],
  skipChatIds?: Set<number>,
  maps?: { chatLayer: Map<number, AttentionLayer>; defaultQuotes: Map<number, number> },
): Promise<void> {
  const api = buildMetaApiContext(maps);
  const d = api['dispatch'] as {
    taskToGroup: (
      chatId: number,
      args: { contentDirection: string; toneGuidance?: string; quotes?: number[] },
    ) => Promise<unknown>;
  };
  for (const a of attention.filter((x) => x.layer === 'L0')) {
    if (!isMetaSubagentChat(a.chatId)) continue;
    if (skipChatIds?.has(a.chatId)) continue;
    await d.taskToGroup(a.chatId, {
      contentDirection: `短句回复用户消息 #${a.messageId ?? ''}：${(a.textPreview ?? a.reason).slice(0, 120)}`,
      toneGuidance: '短、像发微信；群聊微反应；别小作文',
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

  const maps = buildAttentionMaps(attention);

  let result;
  try {
    result = await callWithFallback({
      usage: env().META_USAGE,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content:
            '根据 Attention / Callbacks 做本轮编排。L2 默认沉默；dispatch 时务必 quotes:[msgId]。只在需要时写 js。',
        },
      ],
      maxTokens: 1200,
      temperature: 0.3,
    });
  } catch (err) {
    logger.warn({ err }, 'Meta LLM failed');
    await autoDispatchL0(attention, undefined, maps);
    return { digest: 'meta_llm_failed_auto_l0', codeRan: true };
  }

  const text = result.content ?? '';
  const code = extractJsBlock(text);
  let codeRan = false;
  const dispatchedChatIds = new Set<number>();
  let aborted = false;

  if (code) {
    try {
      await runMetaCode(code, {
        dispatchedChatIds,
        isAborted: () => aborted,
        chatLayer: maps.chatLayer,
        defaultQuotes: maps.defaultQuotes,
      });
      codeRan = true;
    } catch (err) {
      logger.warn({ err }, 'Meta code exec failed');
    } finally {
      aborted = true;
    }
  }

  // L0 must never be silent: gap-fill any L0 chat Meta didn't dispatch.
  const pendingL0 = attention.filter(
    (a) => a.layer === 'L0' && isMetaSubagentChat(a.chatId) && !dispatchedChatIds.has(a.chatId),
  );
  if (pendingL0.length > 0) {
    await autoDispatchL0(pendingL0, dispatchedChatIds, maps);
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
