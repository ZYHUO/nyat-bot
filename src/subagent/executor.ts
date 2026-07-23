import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, ephemeralText, volatileText, deltaText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import type { DispatchTask } from '../meta/types.js';
import { createHostApi, type HostApi } from './host-api.js';
import { sendChatAction } from '../bot/sender/telegram.js';
import { randomUUID } from 'node:crypto';
import { persistCodeActTask } from './task-store.js';

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

const EXECUTOR_SYSTEM = `你是啾咪囝(@hunhebi_bot)的 Subagent。用 CodeAct：写 JavaScript 调用 host API。

人格 / 认人 / 短回见下方 identity + 主人块 + 当前状态 —— 遵守，勿另起客服腔。

可用全局对象:
- telegram.sendText(text, replyToMessageId?)  // **必须 await**，再 endTask
- telegram.sendSticker(fileId) / telegram.react(messageId, emoji)
- memory.search(query) / memory.recallPerson(uid, query) / memory.recentContext(limit?)
- stickers.pick(mood?)
- web.search(query)
- meta.request({ action, detail? })  // journal.write / journal.recent 等
- runtime.endTask(summary)  // 结束时调用
- console.log(...)

规则:
1. 下方已注入最近聊天；通常不必再调 recentContext。
2. **私聊**默认不传 replyTo；**群聊**第一条务必 \`sendText(text, quotes里的messageId)\`（或省略 replyTo，host 会填 quotes）。**禁止**传上下文里其它旧 #id —— 传错会 \`reply_to_mismatch\`，应省略 replyTo 或只用 quotes 里的 id 重试，不要改气泡正文去贴错人。
3. 一轮优先 1 条文字（host 会按标点自动拆成多气泡，首条 quote、后续不 quote）；真要另起一轮最多再 sendText 一次。输出：极短思考 + 一个 \`\`\`js 代码块。
4. **await 完 send* 再** runtime.endTask("一句话摘要")。禁止 fire-and-forget send。
5. 无日记工具；要写/读日记 → meta.request。禁止编造「写完了」。
6. 需要外部信息 → web.search；消化成短人话。
7. 禁止复读用户原话；**禁止复读自己上一句**（别把「臭猫」的回怼贴到别人的「喵喵」上）。`;

function extractJs(text: string): string | null {
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

async function runHostCode(
  code: string,
  host: HostApi,
  opts: { isClosed: () => boolean; onTimeout: () => void },
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = env().CODEACT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction(
      'telegram',
      'memory',
      'stickers',
      'web',
      'meta',
      'runtime',
      'console',
      `"use strict";\n${code}`,
    );
    const out = await Promise.race([
      fn(host.telegram, host.memory, host.stickers, host.web, host.meta, host.runtime, console),
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          opts.onTimeout();
          rej(new Error('codeact_timeout'));
        }, timeoutMs);
      }),
    ]);
    // Model often skips await on sendText before endTask — drain those first.
    await host.runtime.flushBookkeeping();
    if (opts.isClosed()) {
      return { ok: false, output: 'codeact_timeout' };
    }
    return {
      ok: true,
      output: out === undefined ? 'ok' : typeof out === 'string' ? out : JSON.stringify(out),
    };
  } catch (err) {
    await host.runtime.flushBookkeeping().catch(() => undefined);
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** In-process fallback queue (BullMQ down / tests). Per-chat serial + global cap. */
const localByChat = new Map<number, DispatchTask[]>();
const localRunningChats = new Set<number>();
let localActive = 0;
let localPumping = false;

export function enqueueSubagentTaskLocal(task: DispatchTask): void {
  const q = localByChat.get(task.chatId) ?? [];
  q.push(task);
  localByChat.set(task.chatId, q);
  void pumpLocalQueue();
}

async function pumpLocalQueue(): Promise<void> {
  if (localPumping) return;
  localPumping = true;
  try {
    const max = env().CODEACT_CONCURRENCY;
    let claim = true;
    while (claim && localActive < max) {
      claim = false;
      for (const [chatId, q] of [...localByChat.entries()]) {
        if (localActive >= max) break;
        if (localRunningChats.has(chatId) || !q.length) {
          if (!q.length) localByChat.delete(chatId);
          continue;
        }
        const task = q.shift()!;
        if (!q.length) localByChat.delete(chatId);
        localRunningChats.add(chatId);
        localActive += 1;
        claim = true;
        void (async () => {
          try {
            const { tryMarkCodeActActive, clearCodeActActive } = await import('./task-store.js');
            const got = await tryMarkCodeActActive(task.chatId, task.id);
            if (!got) {
              enqueueSubagentTaskLocal(task);
              return;
            }
            try {
              await runCodeActTask(task);
            } finally {
              await clearCodeActActive(task.chatId, task.id);
            }
          } catch (err) {
            logger.warn({ err, taskId: task.id }, 'local CodeAct failed');
          } finally {
            localRunningChats.delete(chatId);
            localActive -= 1;
            void pumpLocalQueue();
          }
        })();
      }
    }
  } finally {
    localPumping = false;
  }
}

/** Public enqueue — prefers durable BullMQ. */
export function enqueueSubagentTask(task: DispatchTask): void {
  void import('./queue.js')
    .then(({ enqueueCodeActJob }) => enqueueCodeActJob(task))
    .catch((err) => {
      logger.warn({ err, taskId: task.id }, 'CodeAct enqueue path failed — local');
      enqueueSubagentTaskLocal(task);
    });
}

export async function runCodeActTask(task: DispatchTask): Promise<void> {
  const state = getGlobalState();
  task.status = 'running';
  state.putTask(task);
  await persistCodeActTask(task);

  let endSummary = '';
  let ended = false;
  let closed = false;

  // Ensure we always have a reply anchor in groups: quotes → parse from direction → none.
  let replyAnchor = task.quoteMessageIds?.[0];
  if (!replyAnchor || replyAnchor <= 0) {
    const m = task.contentDirection.match(/#(\d{1,12})/);
    if (m?.[1]) replyAnchor = Number(m[1]);
  }
  if (replyAnchor && replyAnchor > 0) {
    task.quoteMessageIds = [replyAnchor];
  } else if (task.chatId < 0) {
    logger.warn({ taskId: task.id, chatId: task.chatId }, 'CodeAct: no reply anchor for group task');
  }

  const host = createHostApi(task.chatId, {
    taskId: task.id,
    defaultReplyTo: replyAnchor && replyAnchor > 0 ? replyAnchor : undefined,
    relatedQuoteIds: task.relatedQuoteIds,
    isClosed: () => closed,
    onEnd: (summary) => {
      ended = true;
      endSummary = summary;
    },
  });

  const engine = getContextEngine(`subagent:${task.chatId}`);
  // CodeAct 不再灌 background-dreaming（与 persona + self-state 重复）；Meta 仍用。
  let journal = '';
  try {
    const { readRecentDreamSnippet } = await import('../cron/dream-journal.js');
    journal = (await readRecentDreamSnippet(300)) ?? '';
  } catch { /* optional */ }

  const { buildCodeActIdentityPrompt } = await import('../pipeline/reply/prompt-builder.js');
  const { buildMasterIdentityBlock } = await import('../shared/master-identity.js');
  const { formatBeijingNowLine } = await import('../shared/beijing-time.js');
  const identity = buildCodeActIdentityPrompt(task.targetUserId);

  let recentCtx = '';
  try {
    recentCtx = await host.memory.recentContext(60);
  } catch { /* optional */ }

  // Pin the exact user bubble this task must answer (models otherwise latch onto prior thread).
  let targetBlock = '';
  if (replyAnchor && replyAnchor > 0) {
    try {
      const { getRecent } = await import('../pipeline/context/manager.js');
      const { isShortFollowUpText, isBarePingText } = await import('../meta/reply-context.js');
      const recent = await getRecent(task.chatId, 80);
      const hit = recent.find((m) => m.messageId === replyAnchor && m.role !== 'assistant');
      if (hit) {
        const who = hit.username ? `@${hit.username}` : hit.fullName || `uid:${hit.uid}`;
        const userText = (hit.textContent || '').slice(0, 240);
        const followUp = isShortFollowUpText(userText) || isBarePingText(userText);
        targetBlock =
          `## 本轮必须回的那一句\n` +
          `#${replyAnchor} ${who}: ${userText || '（几乎无正文，可能是 reply+@）'}\n` +
          (followUp
            ? `这是短接话/催问——必须结合下面「最近几句」继续同一话题，禁止当新开场（在听/怎么啦/想听什么）。禁止复读用户原话。`
            : `接住这一句的意思，并结合最近聊天；禁止复读用户原话，也别无故复读自己上一句。`);

        // Trailing thread for short follow-ups (DM「快点告诉我」 after food tease).
        if (followUp && recent.length) {
          const idx = recent.findIndex((m) => m.messageId === replyAnchor);
          const window = (idx >= 0 ? recent.slice(Math.max(0, idx - 6), idx) : recent.slice(-6)).filter(
            (m) => m.messageId !== replyAnchor,
          );
          if (window.length) {
            const lines = window.map((m) => {
              const w =
                m.role === 'assistant'
                  ? '你'
                  : m.username
                    ? `@${m.username}`
                    : m.fullName || `uid:${m.uid}`;
              return `#${m.messageId} ${w}: ${(m.textContent || '').slice(0, 160)}`;
            });
            targetBlock +=
              `\n\n## 最近几句（接话必读）\n` + lines.join('\n') + `\n顺着这个话题回，不要装作没听过。`;
          }
        }

        // Explicit parent bubble — legacy reply path had this; bare @+reply otherwise greets.
        const parentId = hit.replyTo?.messageId;
        if (parentId && parentId > 0) {
          let parent = recent.find((m) => m.messageId === parentId);
          if (!parent) {
            const wider = await getRecent(task.chatId, 120);
            parent = wider.find((m) => m.messageId === parentId);
          }
          const parentWho = parent
            ? parent.username
              ? `@${parent.username}`
              : parent.fullName || `uid:${parent.uid}`
            : hit.replyTo?.fullName || '某人';
          const parentBody = (
            parent?.textContent ||
            hit.replyTo?.textSnippet ||
            ''
          ).slice(0, 1800);
          if (parentBody) {
            targetBlock +=
              `\n\n## 用户正在回复的原消息（必读）\n` +
              `#${parentId} ${parentWho}: ${parentBody}\n` +
              `用户本条若只有 @/很短，是在拉你看上面这段——针对其论点接话，禁止空问候（在呢/怎么啦）。`;
          }
        }
      } else {
        targetBlock = `## 本轮必须回的那一句\nmessageId=#${replyAnchor}（正文见最近聊天）。结合上下文接话，禁止复读自己上一句。`;
      }
    } catch {
      targetBlock = `## 本轮必须回的那一句\nmessageId=#${replyAnchor}`;
    }
  }

  // 主人块永不截断；permanent 其余可截断（认主关键句已在 master 块）
  const masterBlock = buildMasterIdentityBlock();
  let permanent = '';
  try {
    const { loadCachedPrompt } = await import('../shared/config.js');
    permanent = loadCachedPrompt('knowledge/permanent.md').slice(0, 1600);
  } catch { /* optional */ }

  // Roster — persona 认人依赖 [群成员]；legacy reply 有，CodeAct 以前缺。
  let roster = '';
  if (task.chatId < 0) {
    try {
      const { getCachedRoster, setCachedRoster } = await import('../pipeline/reply/member-cache.js');
      const cached = getCachedRoster(task.chatId);
      if (cached) {
        roster = cached;
      } else {
        const { getGroupMembers } = await import('../pipeline/context/manager.js');
        const members = await getGroupMembers(task.chatId);
        if (members.length) {
          roster = members
            .slice(0, 50)
            .map((m) => {
              const tag = m.username ? `@${m.username}` : `uid:${m.uid}`;
              return `${tag} = ${m.fullName}`;
            })
            .join('\n');
          setCachedRoster(task.chatId, roster);
        }
      }
    } catch {
      /* optional */
    }
  }

  // 此刻自我状态（上课/作息）— 与 legacy Heart/reply 对齐，避免「人设上学但 CodeAct 全天闲聊」。
  let selfStateLine = '';
  try {
    const { composeSelfState } = await import('../pipeline/heart/self-state.js');
    const ss = await composeSelfState(task.chatId);
    // CodeAct 没有单独的 [你的念头] 块，用含 thought 的完整叙述即可。
    if (ss?.narration) selfStateLine = ss.narration;
  } catch {
    /* optional */
  }

  const { prompt, manifest } = await engine.assemble([
    staticText('sub-system', EXECUTOR_SYSTEM),
    staticText('sub-identity', identity),
    ephemeralText('sub-master', masterBlock),
    ephemeralText('sub-permanent', permanent ? `## 永久知识\n${permanent}` : ''),
    ephemeralText('sub-roster', roster ? `## 群成员\n${roster}` : ''),
    ephemeralText('sub-self', selfStateLine ? `## 当前状态\n${selfStateLine}` : ''),
    ephemeralText('sub-ctx', recentCtx ? `## 最近聊天\n${recentCtx}` : ''),
    ephemeralText('sub-target', targetBlock),
    deltaText(
      'sub-direction',
      `## Task\nchatId=${task.chatId}\ncontentDirection=${task.contentDirection}` +
        (task.toneGuidance ? `\ntoneGuidance=${task.toneGuidance}` : '') +
        (task.quoteMessageIds?.length ? `\nquotes=${task.quoteMessageIds.join(',')}` : '') +
        (task.targetUserId ? `\ntargetUserId=${task.targetUserId}` : '') +
        (replyAnchor && replyAnchor > 0
          ? `\n\n硬约束：telegram.sendText 的 replyTo 若传只能是本任务 quote #${replyAnchor}（当前 chatId=${task.chatId}）；传别的 #id（尤其是别的群的）会失败。私聊可省略 replyTo；群聊省略时系统会补 #${replyAnchor}。禁止把刚才在别的群说过的话原样贴过来。`
          : '') +
        `\n\n硬提醒：短回。群聊微反应；别写小作文。看 ## Now 的日段（北京时间）。禁止复读自己上一句。`,
    ),
    ephemeralText('sub-banned', `## Banned substrings\n${env().CODEACT_BANNED_WORDS.join(', ')}`),
    ephemeralText('sub-journal', journal ? `## Recent diary snippet\n${journal}` : ''),
    volatileText('sub-now', `## Now\n${formatBeijingNowLine()}\nBegin.`),
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
        content: '执行任务。上下文已注入；按 direction 短回（telegram.sendText），最后 runtime.endTask。',
      },
    ];

    const maxTurns = env().CODEACT_MAX_TURNS;
    for (let turn = 0; turn < maxTurns && !ended && !closed; turn++) {
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

      if (closed) break;

      history.push({ role: 'assistant', content: llmText });
      const code = extractJs(llmText);
      if (!code) {
        history.push({
          role: 'user',
          content: '请用 ```js 代码块调用 API；完成后 runtime.endTask。',
        });
        continue;
      }

      const exec = await runHostCode(code, host, {
        isClosed: () => closed,
        onTimeout: () => {
          // Soft mark — do not flip closed yet so in-flight sendText can finish.
          logger.warn({ taskId: task.id }, 'CodeAct host code timed out (will flush then close)');
        },
      });
      if (exec.output === 'codeact_timeout') {
        closed = true;
      }
      const mismatchHint = !exec.ok && /reply_to_mismatch/.test(exec.output)
        ? `\n提示：群聊 replyTo 只能是 quotes 里的 #${replyAnchor ?? '?'}（或省略让 host 填）。不要换旧 #id，也不要复用错人的气泡正文。`
        : '';
      history.push({
        role: 'user',
        content: exec.ok
          ? `[observation]\n${exec.output}\n${ended ? '(task ended)' : '继续或 endTask。'}`
          : `[observation:error]\n${exec.output}${mismatchHint}\n修正后重试或换策略，仍要 endTask。`,
      });
    }

    if (!ended && !closed) {
      if (host.runtime.didSendText()) {
        endSummary = 'ended_without_endTask';
      } else {
        try {
          const ctx = await host.memory.recentContext(8);
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
                content: `direction: ${task.contentDirection}\ncontext:\n${ctx.slice(0, 1500)}\n\n短回一句。禁止复读用户原话。`,
              },
            ],
            maxTokens: 120,
            temperature: 0.8,
          });
          const text = (fallback.content ?? '').trim().slice(0, 200);
          if (text && !closed) await host.telegram.sendText(text);
          endSummary = 'fallback_plain_reply';
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'CodeAct failsafe reply failed');
          endSummary = 'failed_silent';
        }
      }
    } else if (closed && !endSummary) {
      endSummary = host.runtime.didSendText() ? 'timeout_after_send' : 'failed_timeout';
    }

    // Ensure ctx write + any fire-and-forget sends finished before Meta sees callback.
    await host.runtime.flushBookkeeping();

    task.status = endSummary.startsWith('failed') ? 'failed' : 'done';
    task.resultSummary = endSummary || 'done';
    state.putTask(task);
    await persistCodeActTask(task);
    await state.enqueueCallbackAsync({
      id: randomUUID(),
      taskId: task.id,
      chatId: task.chatId,
      summary: task.resultSummary,
      ok: task.status === 'done',
      createdAt: Date.now(),
    });
  } finally {
    // Flush before closing so late sendText (no await) still delivers.
    await host.runtime.flushBookkeeping().catch(() => undefined);
    closed = true;
    stopTyping();
    try {
      const { clearSpeakerBurst } = await import('../meta/speaker-burst.js');
      await clearSpeakerBurst(task.chatId);
    } catch {
      /* non-critical */
    }
  }
  logger.info({ taskId: task.id, status: task.status, summary: task.resultSummary }, 'CodeAct task done');
}

/** Test helper */
export function _resetSubagentQueue(): void {
  localByChat.clear();
  localRunningChats.clear();
  localActive = 0;
  localPumping = false;
}
