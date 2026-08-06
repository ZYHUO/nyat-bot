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
import { loadCheckpoint, saveCheckpoint, registerAgentChat, unregisterAgentChat } from '../agent/checkpoint.js';
import { drainInterrupts } from '../agent/interrupts.js';
import { compactHistory, restoreMessagesFromCompacted } from '../agent/compaction.js';

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

人格 / 认人 / 回复风格见下方 identity + 主人块 + 当前状态 —— 遵守，勿另起客服腔。

可用全局对象:
- telegram.sendText(text, replyToMessageId?)  // **必须 await**，再 endTask
- telegram.sendSticker(fileId) / telegram.react(messageId, emoji)
- memory.search(query) / memory.recallPerson(uid, query) / memory.recentContext(limit?)
- stickers.pick(mood?)
- web.search(query)
- meta.request({ action, detail? })  // journal.write / journal.recent 等
- runtime.endTask(summary)  // 结束时调用
- console.log(...)

## 电脑使用（SANDBOX_ENABLED 时可用）
- computer.env() — 查看可用运行时（python3/go/node 版本）
- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}
- computer.writeFile(path, content) — 写文件到沙盒目录
- computer.readFile(path) — 读沙盒文件
- computer.listFiles(dir) — 列出沙盒目录文件
- computer.browse(url) — 打开浏览器访问网页
- computer.screenshot() — 截屏当前页面
- computer.click(selector) / computer.type(selector, text) — 操作网页元素
- computer.getText(selector?) — 提取网页文本
- computer.eval(js) — 在页面执行 JS
- computer.scroll(direction, amount) — 滚动页面
- computer.closeBrowser() — 关闭浏览器

## 行为准则
1. 根据用户消息**自然决定**是聊天还是干活：
   - 如果用户要求产出物（写代码、写文件、查询信息生成报告等）→ 规划步骤、逐步执行、完成后 sendText 报告结果
   - 如果只是闲聊、问候、吐槽 → 1-2 轮内 sendText 回复然后 endTask
   - 如果是简单问题（查天气、问时间、搜资料）→ web.search 查完消化成短人话回复
   - **创建了文件（代码/HTML/脚本/图片等）→ 必须用 \`telegram.sendFile(相对路径, caption)\` 把文件发给用户**，再 sendText 说明。文件路径用沙盒相对路径（如 "snake.html"），caption 一句话说明这是什么。禁止只写文件不发。
2. 下方已注入最近聊天；通常不必再调 recentContext。
3. **私聊**默认不传 replyTo；**群聊**第一条务必 \`sendText(text, quotes里的messageId)\`（或省略 replyTo，host 会填 quotes）。**禁止**传上下文里其它旧 #id —— 传错会 \`reply_to_mismatch\`，应省略 replyTo 或只用 quotes 里的 id 重试，不要改气泡正文去贴错人。
4. 一轮优先 1 条文字（host 会按标点自动拆成多气泡，首条 quote、后续不 quote）；真要另起一轮最多再 sendText 一次。输出：极短思考 + 一个 \`\`\`js 代码块。
5. **await 完 send* 再** runtime.endTask("一句话摘要")。禁止 fire-and-forget send。
6. 无日记工具；要写/读日记 → meta.request。禁止编造「写完了」。
7. 禁止复读用户原话；**禁止复读自己上一句**（别把「臭猫」的回怼贴到别人的「喵喵」上）。
8. 写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。
9. 群聊回复前，如果情绪合适（打招呼/开心/傲娇/犯困等），先 \`stickers.pick(mood)\` 拿一个 sticker 用 \`telegram.sendSticker\` 发出去，再接文字。私聊慎用。
10. 道晚安/撒娇/重要情绪表达时可 \`telegram.sendVoice(text)\` 发语音（TTS 关闭或失败会自动跳过，不用管，继续发文字）。`;

function extractJs(text: string): string | null {
  const m = text.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  return m?.[1]?.trim() || null;
}

async function runHostCode(
  code: string,
  host: HostApi,
  opts: { isClosed: () => boolean; onTimeout: () => void; timeoutMs?: number },
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = opts.timeoutMs ?? env().CODEACT_TIMEOUT_MS;
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
      'computer',
      'console',
      `"use strict";\n${code}`,
    );
    const out = await Promise.race([
      fn(host.telegram, host.memory, host.stickers, host.web, host.meta, host.runtime, host.computer, console),
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
    maxTextSends: 5, // enough for both chat (1-2) and work (5)
    messageThreadId: task.messageThreadId,
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
  // 供长期记忆检索用:锚点正文当查询词,最近消息 id 用来排除重复注入。
  let anchorText = '';
  const recentMessageIds = new Set<number>();
  if (replyAnchor && replyAnchor > 0) {
    try {
      const { getRecent } = await import('../pipeline/context/manager.js');
      const { isShortFollowUpText, isBarePingText } = await import('../meta/reply-context.js');
      const recent = await getRecent(task.chatId, 80, task.messageThreadId);
      for (const m of recent) recentMessageIds.add(m.messageId);
      const hit = recent.find((m) => m.messageId === replyAnchor && m.role !== 'assistant');
      if (hit) {
        anchorText = (hit.textContent || '').slice(0, 240);
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
            const wider = await getRecent(task.chatId, 120, task.messageThreadId);
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

  // 长期记忆(「相关往事」)。放在 selfState 之后、assemble 之前 —— 需要 targetBlock
  // 已经算好的锚点正文当查询词。整段永不抛、有硬超时,失败一律空串。
  let memoryBlock = '';
  try {
    const { buildSubagentMemoryBlock } = await import('./memory-context.js');
    // 查询词 = 本轮要回的那句 + 任务方向。只用方向会太笼统(它是「短方向」不是台词),
    // 只用锚点正文则在「快点告诉我」这类短接话上几乎没有信息量,两者相加最稳。
    const query = [anchorText, task.contentDirection].filter(Boolean).join(' ').slice(0, 200);
    memoryBlock = await buildSubagentMemoryBlock({
      chatId: task.chatId,
      query,
      // 最近聊天里已有的不重复贴,否则同一条消息在 prompt 里出现两次。
      excludeMessageIds: recentMessageIds,
    });
  } catch {
    /* non-critical — 调用点再兜一层,异常绝不能冒泡进 CodeAct 主链路 */
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

  // Unified CodeAct: 30 turns, 120s timeout, 4000 maxTokens — model decides chat vs work
  const maxTurns = 30;
  const timeoutMs = 120_000;

  // 长时间 Agent 循环：段号 + checkpoint 恢复 + 用户 interrupt 注入。
  const loopEnabled = env().AGENT_LOOP_ENABLED;
  const segment = task.segment ?? 0;

  // Self-play tasks ([selfplay] marker) use the autonomous self-play prompt.
  const isSelfPlay = task.contentDirection.includes('[selfplay]');
  let systemPrompt = EXECUTOR_SYSTEM;
  if (isSelfPlay) {
    try {
      const { loadCachedPrompt } = await import('../shared/config.js');
      const selfPlayPrompt = loadCachedPrompt('task/self-play.md');
      if (selfPlayPrompt) systemPrompt = selfPlayPrompt;
    } catch {
      /* fall back to EXECUTOR_SYSTEM */
    }
  }

  // AGI Level 4 P4-A: 开工前注入过往经验 —— 犯过的错不再犯第二遍。
  if (env().EPISODE_RECALL_ENABLED) {
    try {
      const { findRelevantExperience } = await import('../agent/episodes.js');
      const hints = findRelevantExperience(task.contentDirection, 3);
      if (hints.length) {
        systemPrompt += `\n\n[过往经验]\n${hints.map((h) => `- (${h.kind}) ${h.content}`).join('\n')}\n以上是之前做类似事总结的教训，能用就用，不适用就忽略。`;
        logger.info({ taskId: task.id, hintCount: hints.length }, 'experience recall injected');
      }
    } catch {
      /* recall is best-effort */
    }
  }

  const { prompt, manifest } = await engine.assemble([
    staticText('sub-system', systemPrompt),
    staticText('sub-identity', identity),
    ephemeralText('sub-master', masterBlock),
    ephemeralText('sub-permanent', permanent ? `## 永久知识\n${permanent}` : ''),
    ephemeralText('sub-roster', roster ? `## 群成员\n${roster}` : ''),
    ephemeralText('sub-self', selfStateLine ? `## 当前状态\n${selfStateLine}` : ''),
    ephemeralText('sub-ctx', recentCtx ? `## 最近聊天\n${recentCtx}` : ''),
    // 恒定传入(空时传 ''),与同组的 sub-permanent / sub-journal 一致 ——
    // 不用条件展开把 id 从数组里摘掉:引擎实现在外部包里,"这次缺了这个 id"
    // 在 delta/ephemeral 语义下是否等于"沿用上次的值"无法从代码证实,而赌错
    // 的后果是上一轮的记忆黏在这一轮的 prompt 上。
    ephemeralText('sub-memory', memoryBlock ? `## 相关往事(仅供参考,不是本轮要回的话)\n${memoryBlock}` : ''),
    ephemeralText('sub-target', targetBlock),
    deltaText(
      'sub-direction',
      `## Task\nchatId=${task.chatId}\ncontentDirection=${task.contentDirection}` +
        (task.toneGuidance ? `\ntoneGuidance=${task.toneGuidance}` : '') +
        (task.quoteMessageIds?.length ? `\nquotes=${task.quoteMessageIds.join(',')}` : '') +
        (task.targetUserId ? `\ntargetUserId=${task.targetUserId}` : '') +
        (loopEnabled && segment > 0
          ? `\n[长时间任务续跑] 这是第 ${segment + 1} 段（每段最多 ${maxTurns} 轮）。上面有此前执行摘要。继续完成任务；本段结束时若未完成，系统会自动保存进度并在下段继续，你无需在段末强行收尾，但每完成一个里程碑就 sendText 汇报一次进展。`
          : '') +
        (loopEnabled && segment + 1 >= env().AGENT_MAX_SEGMENTS
          ? `\n[硬性提醒] 这是最后一段。本段结束前必须收尾：sendText 总结做了什么/卡在哪/产出在哪，然后 runtime.endTask。`
          : '') +
(replyAnchor && replyAnchor > 0
          ? `\\\\n\\\\n硬约束：telegram.sendText 的 replyTo 若传只能是本任务 quote #${replyAnchor}（当前 chatId=${task.chatId}）；传别的 #id（尤其是别的群的）会失败。私聊可省略 replyTo；群聊省略时系统会补 #${replyAnchor}。禁止把刚才在别的群说过的话原样贴过来。`
          : '') +
        `\\\\n\\\\n根据用户消息自行决定：简单聊天就 1-2 轮回复，需要做事就多轮工具调用，完成后 sendText 报告结果。看 ## Now 的日段（北京时间）。禁止复读用户原话。`,
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

  // 长时间 Agent 循环：checkpoint 恢复 + 用户 interrupt 注入（loopEnabled/segment 见上方）。
  let resumeSummary = '';
  let restoredHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | null = null;
  if (loopEnabled && task.checkpointKey) {
    try {
      const cp = await loadCheckpoint(task.checkpointKey);
      if (cp) {
        restoredHistory = restoreMessagesFromCompacted(cp);
        resumeSummary = cp.progressSummary;
        task.totalTurns = cp.totalTurns ?? task.totalTurns ?? 0;
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'agent checkpoint restore failed — starting fresh');
    }
  }

  let history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  if (restoredHistory && restoredHistory.length > 0) {
    history = restoredHistory;
  } else {
    history = [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content:
          '执行任务。上下文已注入，根据 contentDirection 自行决定：是聊天就回一句，是干活就规划步骤逐步执行。每步写一个 ```js 代码块调用 API，观察结果后继续下一步。完成后 sendText 报告结果，然后 runtime.endTask。',
      },
    ];
  }

  // 任务进行中，主人/群友发来的新消息 → 注入本轮，模型先响应再继续。
  if (loopEnabled && segment > 0) {
    try {
      const interrupts = await drainInterrupts(task.id);
      if (interrupts.length > 0) {
        const block = interrupts
          .map((i) => `- (${new Date(i.at).toLocaleString('zh-CN', { hour12: false })}) ${i.from}: ${i.text}`)
          .join('\n');
        history.push({
          role: 'user',
          content: `[任务进行中，${interrupts.length > 1 ? '有人' : '有人'}发来新消息]\n${block}\n先简短回应这些消息（问进度就汇报当前进度；让停就停下收尾；补充需求就纳入计划），然后继续当前任务。`,
        });
      }
    } catch {
      /* non-critical */
    }
  }

  const stopTyping = startTypingHeartbeat(task.chatId);
  try {
    let turnsRun = 0;
    for (let turn = 0; turn < maxTurns && !ended && !closed; turn++) {
      turnsRun++;
      let llmText = '';
      try {
        const result = await callWithFallback({
          usage: env().CODEACT_USAGE,
          messages: history,
          maxTokens: 4000,
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
          // Soft mark - do not flip closed yet so in-flight sendText can finish.
          logger.warn({ taskId: task.id }, 'CodeAct host code timed out (will flush then close)');
        },
        timeoutMs,
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
          ? `[observation]\n${exec.output}\n${ended ? '(task ended)' : `已完成步骤 ${turn + 1}/${maxTurns}。继续下一步，或完成后 runtime.endTask("结果摘要")。`}`
          : `[observation:error]\n${exec.output}${mismatchHint}\n操作失败了，分析错误原因调整策略重试，或换一种方法。${turn + 1 >= maxTurns ? '这是最后一轮，sendText 说明进展然后 endTask。' : ''}`,
      });
    }

    if (!ended && !closed) {
      // 长时间 Agent 循环：段末未完成 + 已有产出 → checkpoint + 重入队续跑。
      // 30 轮不是天花板，任务可以跨段跑几十分钟/几小时（像 Hermes 的持久 agent）。
      const maxSegments = env().AGENT_MAX_SEGMENTS;
      const canResume =
        loopEnabled &&
        segment + 1 < maxSegments &&
        host.runtime.didProduce();

      if (canResume) {
        let progressSummary = resumeSummary;
        try {
          const total = (task.totalTurns ?? 0) + turnsRun;
          if (total >= env().AGENT_COMPACT_AFTER_TURNS) {
            const c = await compactHistory({
              history,
              progressSummary: resumeSummary,
              contentDirection: task.contentDirection,
            });
            progressSummary = c.summary;
          } else {
            // 轮数不多：用模型本段最后一句当进度摘要，不调 LLM。
            const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
            if (lastAssistant) {
              progressSummary =
                `${resumeSummary ? `${resumeSummary}\n` : ''}[段 ${segment + 1}] ${lastAssistant.content.slice(0, 500)}`.slice(
                  0,
                  2000,
                );
            }
          }
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'agent segment summary failed');
        }

        const key = await saveCheckpoint(task, {
          history,
          progressSummary,
          artifacts: [],
          segment: segment + 1,
          totalTurns: (task.totalTurns ?? 0) + turnsRun,
        });

        task.segment = segment + 1;
        task.checkpointKey = key;
        task.totalTurns = (task.totalTurns ?? 0) + turnsRun;
        task.status = 'queued';
        state.putTask(task);
        await persistCodeActTask(task);
        // 注册 chat → task 索引：任务等待下一段期间用户消息走 interrupt 而不是 dispatch。
        await registerAgentChat(task.chatId, task.id);

        const { enqueueResumeCodeActJob } = await import('./queue.js');
        await enqueueResumeCodeActJob(task);
        endSummary = `resumed_seg${segment + 1}`;
        logger.info(
          {
            taskId: task.id,
            chatId: task.chatId,
            segment: segment + 1,
            totalTurns: task.totalTurns,
            maxSegments,
          },
          'agent task checkpointed & re-enqueued for next segment',
        );
        // 注意：不 enqueueCallback —— 任务未完成，Meta 不应收到完成回调。
      } else if (host.runtime.didSendText()) {
        endSummary = 'ended_without_endTask';
      } else {
        // Failsafe: bot didn't produce anything — generate an honest report
        try {
          const ctx = await host.memory.recentContext(8);
          const fallback = await callWithFallback({
            usage: env().CODEACT_USAGE,
            messages: [
              {
                role: 'system',
                content:
                  buildCodeActIdentityPrompt() +
                  '\n\n现在只输出一句纯文本回复，不要 JSON，不要代码。诚实说明没搞定，别假装完成了。',
              },
              {
                role: 'user',
                content: `direction: ${task.contentDirection}\ncontext:\n${ctx.slice(0, 1500)}\n\n诚实说明情况。如果是在做任务没完成，说原因；如果是聊天没回上，随便接一句。`,
              },
            ],
            maxTokens: 300,
            temperature: 0.5,
          });
          const text = (fallback.content ?? '').trim().slice(0, 300);
          if (text && !closed) {
            try {
              const { sendMessage } = await import('../bot/sender/telegram.js');
              await sendMessage(task.chatId, text, task.quoteMessageIds?.[0]);
            } catch {
              /* ultimate fallback */
            }
          }
          endSummary = 'failsafe_plain_reply';
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

    // 续跑任务不进入终态：保持 queued，等下一段完成/超限后再收尾。
    const resumed = endSummary.startsWith('resumed_seg');
    if (!resumed) {
      task.status = endSummary.startsWith('failed') ? 'failed' : 'done';
      task.resultSummary = endSummary || 'done';
      state.putTask(task);
      await persistCodeActTask(task);
      // 任务终态：解除 chat → task 索引，恢复该 chat 的正常 dispatch。
      await unregisterAgentChat(task.chatId, task.id);

      // AGI Level 4 P4-A: 终态复盘蒸馏 —— 只留下过痕迹的任务才复盘
      // （纯闲聊 sendText 一句就结束的也蒸，成本极低；失败任务重点挖 pitfall）。
      // fire-and-forget：复盘失败静默 warn，不阻塞 callback、不烧重试。
      if (env().EPISODE_DISTILL_ENABLED && host.runtime.didProduce()) {
        const tailText = history
          .slice(-12)
          .map((m) => `${m.role}: ${m.content.slice(0, 250)}`)
          .join('\n');
        void import('../agent/distiller.js')
          .then(({ distillEpisode }) =>
            distillEpisode({
              task,
              outcome: task.status === 'done' ? 'done' : 'failed',
              progressSummary: resumeSummary ?? endSummary,
              tailText,
            }),
          )
          .then((r) => {
            if (r?.followUpGoal) {
              // P4-B 钩子占位：goal tracker 落地后接 createGoal。
              logger.info({ taskId: task.id, followUpGoal: r.followUpGoal }, 'distill suggests follow-up goal');
            }
          })
          .catch((err) => logger.warn({ err, taskId: task.id }, 'episode distill failed'));
      }

      await state.enqueueCallbackAsync({
        id: randomUUID(),
        taskId: task.id,
        chatId: task.chatId,
        summary: task.resultSummary,
        ok: task.status === 'done',
        createdAt: Date.now(),
      });
    }
  } finally {
    // Flush before closing so late sendText (no await) still delivers.
    await host.runtime.flushBookkeeping().catch(() => undefined);
    closed = true;
    stopTyping();
    try {
      const { clearSpeakerBurst } = await import('../meta/speaker-burst.js');
      await clearSpeakerBurst(task.chatId, task.targetUserId);
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
