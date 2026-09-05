import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { getContextEngine, staticText, deltaText, ephemeralText, volatileText } from '../context-engine/index.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { formatBeijingNowLine } from '../shared/beijing-time.js';
import { buildMasterIdentityBlock, masterShortHint } from '../shared/master-identity.js';
import { getGlobalState } from './global-state.js';
import { resolveJournalChatLink, getJournalChannelInfo } from '../cron/dream-journal.js';
import { buildMetaApiContext } from './meta-api.js';
import type { AttentionItem, AttentionLayer, SubagentCallback } from './types.js';
import { isMetaSubagentChat } from './flags.js';
import { persistDigest, recentDigests as recentPersistedDigests } from './session-digest.js';
import {
  buildL0ContentDirection,
  filterAttentionForMetaLlm,
  formatAttentionReplyToBit,
  replyToFromPayload,
} from './reply-context.js';

const META_SYSTEM = `你是啾咪囝的 Meta Agent（全局编排大脑）。你不直接发群消息。
你通过写 JavaScript 调用沙盒 API 做决策：

可用全局对象（已注入）:
- dispatch.taskToGroup(chatId, { contentDirection, toneGuidance?, quotes?, trackingKey?, interrupt? })
- dispatch.getTask(taskId) / dispatch.listTasks(chatId?)
- journal.tryWrite({ slot?: 'morning'|'bedtime'|'free', force?: boolean }) → 写真实日记（可 SKIP；force 跳过冷却）
- journal.recent() → 看最近日记片段
- todo.add(text) / todo.list() / todo.remove(id)
- agents.listStatus()
- conversations.query(hint)
- memory.searchEntities(query)
- console.log(...)

规则:
1. contentDirection 只写「要做什么」的**短方向**（如「短回摸头」「短接梗」「傲娇拒绝」），**禁止写具体台词/结论**（如「简单说没事」「本喵在看着」），**不要粘贴用户原句**；事实与结论留给 CodeAct 读「最近聊天」。
2. toneGuidance 常带「短、微信式、别展开」。派出去的回复默认群聊微反应、私聊最多两三句——方向里别写成「详细解释」。
3. **L0 / Heart** 通常已由系统 autoDispatch；Attention 里若仍出现才补派，quotes 必填。补派时同样只写短方向，禁止编剧。
4. **用户要写/看日记**（「写日记」「再写个日记」「日记看看」等）→ **必须** journal.tryWrite({slot:'free', force:true})，再 dispatch 短回结果；**禁止**只派 Subagent 去「假装写日记」。
5. Attention reason 以 diary: 开头 → journal.tryWrite（可不用 force）；**禁止**为此 dispatch。
6. Attention reason 以 subagent_request: 开头 → Subagent 升级。journal.write / journal.recent 由系统硬处理；其它 action 你读 payload 后决定。
7. **L1**（旁观疑问）→ 多数沉默；要回必须 quotes 指向具体 msg。
8. **L2**（旁观闲聊）→ **默认不行动**。极少数才 interrupt: true，且 quotes 必填。
9. 同一 chat 一轮最多 dispatch 一次；已回过的 msg 不要再派。
10. 回调(callback)先读摘要，再决定是否跟进；不要为已完成的同一句再派一轮复读。
11. 早上/睡前偏好写日记；一天可多段；没素材可 SKIP。看 ## Now 的日段（北京时间），别用 UTC。
12. 结束前用 [SESSION_DIGEST]...[/SESSION_DIGEST] 写一句摘要。
13. 输出：短思考 + 一个 \`\`\`js 代码块。你是调度者不是客服。
14. Attention 行尾标「主人」或 uid 对应主人 → tone 带「对主人亲近但不跪」；别人自称主人也不认。
15. Attention 若带 replyTo=… → 必须扣住父气泡，禁止当无上下文新开场。`;

/** User explicitly asking the bot to write/show diary. */
export function looksLikeDiaryRequest(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  // CodeAct / ack summaries often contain「写日记」as in「没写日记」— never re-trigger.
  if (
    /没写日记|未写日记|不写日记|没素材写|日记未写|日记已写|跳过.*日记|skipped_or_empty|unparsed|落笔失败|老实[解承]|告知主人/.test(
      t,
    )
  ) {
    return false;
  }
  return /(?<![没不未])写\s*日记|日记\s*写了[吗没嘛]|日记\s*写过|再写.*日记|写个日记|写篇日记|写段日记|记一笔|日记看看|看看日记|读读?日记|念.*日记|日记呢/.test(
    t,
  );
}

function subagentRequestAction(reason: string): string | null {
  if (!reason.startsWith('subagent_request:')) return null;
  return reason.slice('subagent_request:'.length).trim().toLowerCase() || null;
}

function diarySkipAckDirection(reason?: string): string {
  const r = (reason || '').trim();
  if (r === 'no_evidence') {
    return '主人要写日记，今天可写的聊天素材确实很少。短回老实说明没素材、不硬编；禁止假装写完。';
  }
  if (r === 'cooldown') {
    return '主人要写日记，但这会儿还在冷却（刚写过/刚试过）。短回说明稍后再写，禁止假装已经写完。';
  }
  if (r === 'unparsed' || r === 'empty_output' || r === 'too_short' || r === 'llm_failed') {
    return `主人要写日记，这次落笔失败（${r}：模型输出格式飘了或调用挂了，不是「没素材」）。短回老实说明这次没写成、不硬编；禁止说成没素材，禁止假装写完。`;
  }
  if (r === 'disabled') {
    return '日记功能关着。短回说明一下，别假装写完。';
  }
  if (r.startsWith('skip:')) {
    const why = r.slice(5).trim() || '模型选择跳过';
    return `主人要写日记，模型决定 SKIP（${why.slice(0, 80)}）。短回说明跳过了、不硬编；禁止假装写完。只有真没记录时才能说没素材。`;
  }
  if (r === 'skipped_or_empty' || r === 'model_skip' || !r) {
    return '主人要写日记，这次模型选择跳过。短回说明跳过了、不硬编；禁止说成没素材，禁止假装写完。';
  }
  return `主人要写日记，这次没写成（${r.slice(0, 80)}）。短回老实说明原因、不硬编；禁止假装写完。不要默认说成没素材。`;
}

async function interceptDiaryAttention(
  attention: AttentionItem[],
  opts: {
    dispatchedChatIds: Set<number>;
    chatLayer: Map<number, AttentionLayer>;
    defaultQuotes: Map<number, number>;
    defaultTargetUserIds: Map<number, number>;
  },
): Promise<AttentionItem[]> {
  const remaining: AttentionItem[] = [];
  const api = buildMetaApiContext({
    dispatchedChatIds: opts.dispatchedChatIds,
    chatLayer: opts.chatLayer,
    defaultQuotes: opts.defaultQuotes,
    defaultTargetUserIds: opts.defaultTargetUserIds,
  });
  const journal = api['journal'] as {
    tryWrite: (args?: {
      slot?: string;
      force?: boolean;
    }) => Promise<{ wrote: boolean; reason?: string; snippet?: string | null; slot: string }>;
    recent: (maxChars?: number) => Promise<{ snippet: string | null }>;
  };
  const dispatch = api['dispatch'] as {
    taskToGroup: (
      chatId: number,
      args: {
        contentDirection: string;
        toneGuidance?: string;
        quotes?: number[];
        targetUserId?: number;
        messageThreadId?: number;
      },
    ) => Promise<{ taskId: string }>;
  };

  const handledChats = new Set<number>();

  /** Max requeue attempts for diary ack when chat is busy (prevents infinite retry loop). */
  const DIARY_ACK_MAX_RETRIES = 3;

  async function ackDiary(
    a: AttentionItem,
    result: { wrote: boolean; reason?: string; snippet?: string | null },
  ): Promise<void> {
    const snip = (result.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    let journalLink: string | null = null;
    if (result.wrote) {
      journalLink = await resolveJournalChatLink();
    }
    const linkNote = journalLink ? `\n\n日记发布在频道 ${journalLink}（只在频道里能看到完整版）。` : '';
    const direction = result.wrote
      ? `主人要日记。真实日记已写入。短回确认；可点一点真实片段：「${snip || '（见频道/文件）'}」${linkNote ? `频道链接：${journalLink}` : ''}。禁止编造未写入内容，禁止说「写完了」却无真实写入。`
      : diarySkipAckDirection(result.reason);

    // Non-Meta chats: dispatch.taskToGroup would throw, so send a short ack
    // directly via Telegram. Without this, users in chats not on the Meta path
    // would write a diary but receive no confirmation.
    if (!isMetaSubagentChat(a.chatId)) {
      try {
        const { sendMessage } = await import('../bot/sender/telegram.js');
        const ackText = result.wrote
          ? `日记已写好啦～${snip ? `「${snip}」` : ''}${journalLink ? `\n发布在频道：${journalLink}` : ''}`
          : diarySkipAckDirection(result.reason).slice(0, 200);
        await sendMessage(a.chatId, ackText, a.messageId, a.messageThreadId);
      } catch (err) {
        logger.warn({ err, chatId: a.chatId }, 'Meta diary ack direct send failed');
      }
      return;
    }

    const dispatched = await dispatch.taskToGroup(a.chatId, {
      contentDirection: direction,
      toneGuidance: '短、傲娇、像发微信；别小作文',
      quotes: a.messageId ? [a.messageId] : undefined,
      targetUserId: a.userId && a.userId > 0 ? a.userId : undefined,
      messageThreadId: a.messageThreadId,
    });
    if (dispatched.taskId !== 'skipped_busy') return;
    // Cap retries: without this, a busy chat requeues diary_ack every tick →
    // interceptDiaryAttention re-dispatches the same ack → duplicate bubbles.
    const retryCount =
      typeof a.payload?.['ackRetry'] === 'number' ? (a.payload['ackRetry'] as number) : 0;
    if (retryCount >= DIARY_ACK_MAX_RETRIES) {
      logger.warn(
        { chatId: a.chatId, retryCount, messageId: a.messageId },
        'Meta diary ack requeue cap reached — dropping ack',
      );
      return;
    }
    try {
      const { getAttentionAccumulator } = await import('./attention.js');
      await getAttentionAccumulator().requeue([
        {
          ...a,
          id: `diary-ack-${a.chatId}-${Date.now()}`,
          reason: result.wrote ? 'diary_ack:wrote' : `diary_ack:skip`,
          textPreview: result.wrote
            ? `日记已写：${snip || '见文件'}`
            : `日记未写：${result.reason || 'skip'}`,
          createdAt: Date.now(),
          payload: {
            wrote: result.wrote,
            reason: result.reason,
            snippet: result.snippet ?? null,
            ackRetry: retryCount + 1,
          },
        },
      ]);
    } catch (err) {
      logger.warn({ err, chatId: a.chatId }, 'Meta diary ack requeue failed');
    }
  }

  for (const a of attention) {
    // Callbacks / diary_ack leftovers must not be re-parsed as user diary asks
    // (summary text often contains「写日记」and used to cascade another CodeAct).
    if (a.layer === 'L1_CALLBACK' || a.reason.startsWith('callback:')) {
      remaining.push(a);
      continue;
    }

    const text = a.textPreview ?? '';
    const ackOnly = a.reason.startsWith('diary_ack:');
    const reqAction = subagentRequestAction(a.reason);
    const userAsk = !ackOnly && !reqAction && looksLikeDiaryRequest(text);
    const nudge = a.reason.startsWith('diary:');
    const journalReq =
      reqAction === 'journal.write' ||
      reqAction === 'journal.trywrite' ||
      reqAction === 'journal.recent';

    if (!ackOnly && !userAsk && !nudge && !journalReq) {
      remaining.push(a);
      continue;
    }
    if (handledChats.has(a.chatId)) continue;

    try {
      if (ackOnly) {
        handledChats.add(a.chatId);
        const wrote = a.reason.includes('wrote') || a.payload?.['wrote'] === true;
        await ackDiary(a, {
          wrote,
          reason: typeof a.payload?.['reason'] === 'string' ? a.payload['reason'] : 'skip',
          snippet: typeof a.payload?.['snippet'] === 'string' ? a.payload['snippet'] : text,
        });
        continue;
      }

      if (reqAction === 'journal.recent') {
        handledChats.add(a.chatId);
        if (!env().DREAM_JOURNAL_ENABLED) {
          await dispatch.taskToGroup(a.chatId, {
            contentDirection: '日记功能关着。短回说明一下，别编日记。',
            toneGuidance: '短、像发微信',
            quotes: a.messageId ? [a.messageId] : undefined,
            messageThreadId: a.messageThreadId,
          });
          continue;
        }
        const { snippet } = await journal.recent(280);
        const snip = (snippet || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        await dispatch.taskToGroup(a.chatId, {
          contentDirection: snip
            ? `主人要看日记。短回并点一点真实片段：「${snip}」。禁止编造。`
            : '暂时没有可念的日记片段。短回说明，别编。',
          toneGuidance: '短、傲娇、像发微信；别小作文',
          quotes: a.messageId ? [a.messageId] : undefined,
          messageThreadId: a.messageThreadId,
        });
        logger.info({ chatId: a.chatId }, 'Meta subagent_request journal.recent');
        continue;
      }

      if (
        reqAction === 'journal.write' ||
        reqAction === 'journal.trywrite' ||
        userAsk ||
        nudge
      ) {
        if (!env().DREAM_JOURNAL_ENABLED) {
          handledChats.add(a.chatId);
          if (userAsk || reqAction) {
            await dispatch.taskToGroup(a.chatId, {
              contentDirection: '日记功能关着。短回说明一下，别假装写完。',
              toneGuidance: '短、像发微信',
              quotes: a.messageId ? [a.messageId] : undefined,
              messageThreadId: a.messageThreadId,
            });
          }
          continue;
        }

        const slot =
          nudge && a.reason.includes('morning')
            ? 'morning'
            : nudge && a.reason.includes('bedtime')
              ? 'bedtime'
              : 'free';
        const force = !!(userAsk || reqAction);
        const result = await journal.tryWrite({ slot, force });
        handledChats.add(a.chatId);
        logger.info(
          { chatId: a.chatId, userAsk, nudge, reqAction, ...result },
          'Meta diary intercept',
        );

        if (userAsk || reqAction) await ackDiary(a, result);
        continue;
      }
    } catch (err) {
      logger.warn({ err, chatId: a.chatId }, 'Meta diary intercept failed');
      remaining.push(a);
    }
  }

  // Only filter diary-type items for handled chats; non-diary items (L0 mentions,
  // L1 questions) must still reach autoDispatchL0 / Meta LLM even if a diary was
  // processed for the same chat in this batch.
  return remaining.filter((a) => {
    if (!handledChats.has(a.chatId)) return true;
    // If the chat had a diary handled, only drop diary-type items
    const text = a.textPreview ?? '';
    const ackOnly = a.reason.startsWith('diary_ack:');
    const reqAction = subagentRequestAction(a.reason);
    const userAsk = !ackOnly && !reqAction && looksLikeDiaryRequest(text);
    const nudge = a.reason.startsWith('diary:');
    const journalReq =
      reqAction === 'journal.write' ||
      reqAction === 'journal.trywrite' ||
      reqAction === 'journal.recent';
    return !(ackOnly || userAsk || nudge || journalReq);
  });
}

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
  defaultTargetUserIds: Map<number, number>;
} {
  const rank: Record<string, number> = { L0: 3, L1_CALLBACK: 2, L1: 2, L2: 1 };
  const chatLayer = new Map<number, AttentionLayer>();
  const defaultQuotes = new Map<number, number>();
  const defaultTargetUserIds = new Map<number, number>();
  for (const a of attention) {
    const prev = chatLayer.get(a.chatId);
    if (!prev || (rank[a.layer] ?? 0) >= (rank[prev] ?? 0)) {
      chatLayer.set(a.chatId, a.layer);
    }
    if (a.messageId && a.messageId > 0) {
      // Prefer the newest messageId as the reply quote (burst → last bubble).
      const existing = defaultQuotes.get(a.chatId) ?? 0;
      const layerOk = a.layer === 'L0' || a.layer === 'L1' || a.layer === 'L1_CALLBACK';
      if (!existing || (layerOk && a.messageId >= existing)) {
        defaultQuotes.set(a.chatId, a.messageId);
        if (a.userId && a.userId > 0) defaultTargetUserIds.set(a.chatId, a.userId);
      }
    } else if (a.userId && a.userId > 0 && !defaultTargetUserIds.has(a.chatId)) {
      defaultTargetUserIds.set(a.chatId, a.userId);
    }
  }
  return { chatLayer, defaultQuotes, defaultTargetUserIds };
}

async function runMetaCode(
  code: string,
  opts: {
    dispatchedChatIds: Set<number>;
    isAborted: () => boolean;
    chatLayer: Map<number, AttentionLayer>;
    defaultQuotes: Map<number, number>;
    defaultTargetUserIds: Map<number, number>;
  },
): Promise<void> {
  const api = buildMetaApiContext(opts);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFunction(...Object.keys(api), 'console', `"use strict";\n${code}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(...Object.values(api), console),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('meta_code_timeout')), env().CODEACT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function autoDispatchL0(
  attention: AttentionItem[],
  skipChatIds?: Set<number>,
  maps?: {
    chatLayer: Map<number, AttentionLayer>;
    defaultQuotes: Map<number, number>;
    defaultTargetUserIds: Map<number, number>;
  },
): Promise<Set<number>> {
  const busyChatIds = new Set<number>();
  const api = buildMetaApiContext({
    dispatchedChatIds: skipChatIds,
    chatLayer: maps?.chatLayer,
    defaultQuotes: maps?.defaultQuotes,
    defaultTargetUserIds: maps?.defaultTargetUserIds,
  });
  const d = api['dispatch'] as {
    taskToGroup: (
      chatId: number,
      args: {
        contentDirection: string;
        toneGuidance?: string;
        quotes?: number[];
        relatedQuotes?: number[];
        targetUserId?: number;
        messageThreadId?: number;
        skipDispatchGate?: boolean;
      },
    ) => Promise<{ taskId: string }>;
  };

  // One CodeAct per chat — L0 + Heart-elevated L1 (reason heart:… / wait_resume:heart:…).
  const l0ByChat = new Map<number, AttentionItem[]>();
  for (const a of attention) {
    const heartForce = a.reason.includes('heart:');
    if (a.layer !== 'L0' && !heartForce) continue;
    if (!isMetaSubagentChat(a.chatId)) continue;
    if (skipChatIds?.has(a.chatId)) continue;
    const list = l0ByChat.get(a.chatId);
    if (list) list.push(a);
    else l0ByChat.set(a.chatId, [a]);
  }

  for (const [chatId, siblings] of l0ByChat) {
    const withIds = siblings.filter((x) => (x.messageId ?? 0) > 0);
    // 长时间/进行中 Agent 任务：该 chat 有活跃任务 → 消息走 interrupt（执行器
    // 每轮开头排入 history，模型实时响应；硬停词立即终止），不重复 dispatch，
    // 避免同 chat 并发/重复回复。P1 起不再依赖 AGENT_LOOP_ENABLED —— 单段任务
    // 的 30 轮/120s 里用户消息同样该进 interrupt 而不是再派一个 CodeAct。
    {
      try {
        const { getAgentTaskIdForChat } = await import('../agent/checkpoint.js');
        const { pushInterrupt } = await import('../agent/interrupts.js');
        const agentTaskId = await getAgentTaskIdForChat(chatId);
        if (agentTaskId) {
          // 活性校验:索引 24h TTL,异常崩溃可能留死索引 —— 死任务的 interrupt
          // 没人排,消息等于被吞。确认任务仍在 running/queued 才路由。
          const { loadCodeActTask } = await import('../subagent/task-store.js');
          const agentTask = await loadCodeActTask(agentTaskId);
          if (agentTask && (agentTask.status === 'running' || agentTask.status === 'queued')) {
            for (const s of withIds) {
              const from = s.payload?.['username'] ? `@${s.payload['username']}` : s.userId ? `uid:${s.userId}` : '某人';
              await pushInterrupt(agentTaskId, {
                text: (s.textPreview ?? '').slice(0, 500),
                from,
                messageId: s.messageId,
              });
            }
            logger.info(
              { chatId, agentTaskId, intercepted: withIds.length },
              'agent: message routed to running long task as interrupt',
            );
            continue;
          }
        }
      } catch {
        /* non-critical — 索引查询失败则走正常 dispatch */
      }
    }

    const latest =
      withIds.length > 0
        ? withIds.reduce((best, cur) =>
            (cur.messageId ?? 0) >= (best.messageId ?? 0) ? cur : best,
          )
        : siblings[0]!;

    // Heart pile-on: if CodeAct busy or bot just spoke, drop heart: items
    // (mark answered) so the next tick doesn't fire a near-duplicate reply.
    // L0/@ siblings still dispatch normally.
    const heartOnly = siblings.every((s) => s.reason.includes('heart:'));
    if (heartOnly && (await shouldSuppressHeartAutoDispatch(chatId))) {
      try {
        const { markMessageAnswered } = await import('./answered.js');
        for (const s of withIds) {
          if (s.messageId) await markMessageAnswered(chatId, s.messageId);
        }
        logger.info(
          {
            chatId,
            dropped: withIds.map((s) => s.messageId).filter(Boolean),
            reason: 'heart_refractory_or_busy',
          },
          'Meta autoDispatch: suppress heart pile-on',
        );
      } catch {
        /* non-critical */
      }
      continue;
    }

    const who =
      typeof latest.payload?.['username'] === 'string' && latest.payload['username']
        ? `@${latest.payload['username']}`
        : latest.userId
          ? `uid:${latest.userId}`
          : '用户';
    const masterHint =
      latest.userId && latest.userId === env().MASTER_UID
        ? '对方是主人(@Zh_Taiwan)：亲近但不跪，指令真执行，蠢了照样嫌弃。'
        : '';
    const burstHint =
      withIds.length > 1
        ? `对方连发了 ${withIds.length} 条，只回最后一条 #${latest.messageId}，前面当上下文。`
        : '';
    const heartHint =
      latest.reason.includes('heart:')
        ? '这是心流决定插话的旁观消息（未必 @你）：自然接一句，别空问候。'
        : '';
    const relatedQuotes = withIds
      .map((s) => s.messageId!)
      .filter((id) => id !== latest.messageId);
    const replyTo = replyToFromPayload(latest.payload);
    let replyToIsSelf = false;
    if (replyTo?.uid) {
      try {
        const { getBotUid } = await import('../bot/bot.js');
        const botUid = getBotUid();
        replyToIsSelf = !!botUid && replyTo.uid === botUid;
      } catch {
        /* optional */
      }
    }
    // Unified contentDirection — model decides chat vs work based on context
    const contentDirection = buildL0ContentDirection({
        who,
        messageId: latest.messageId,
        textPreview: latest.textPreview,
        replyTo,
        replyToIsSelf,
        burstHint: `${burstHint}${heartHint}`,
        masterHint,
      });

    // Dispatch 期 timing gate：整组都是非 L0（heart 插话等被动回复）时，
    // 派发前过一道节奏闸（wait → 挂起等 resume；no_action/defer → 本次不说）。
    // 混入任何 L0 direct（@/DM/回复 bot）整组 bypass，对齐老 gate 语义。
    if (siblings.every((s) => s.layer !== 'L0')) {
      try {
        const { evaluateDispatchGate } = await import('./dispatch-gate.js');
        const gate = await evaluateDispatchGate({
          chatId,
          layer: latest.layer,
          reason: latest.reason,
          messageId: latest.messageId,
          userId: latest.userId,
          textPreview: latest.textPreview,
          messageThreadId: latest.messageThreadId,
          payload: latest.payload,
          deferCount:
            typeof latest.payload?.['deferCount'] === 'number'
              ? (latest.payload['deferCount'] as number)
              : 0,
        });
        if (gate.verdict === 'suppress') {
          logger.info({ chatId, reason: gate.reason }, 'Meta autoDispatch: dispatch gate suppressed');
          // 本 tick 不再让 Meta LLM 对同 chat 补派（wait/defer 有自己的重评链路）。
          skipChatIds?.add(chatId);
          continue;
        }
      } catch (err) {
        logger.warn({ err, chatId }, 'Meta autoDispatch gate failed — fail-open dispatch');
      }
    }

    // Grounding 并行核查（GROUNDING_ENABLED 门控）：事实/问题类消息在派发的同时
    // 后台起联网搜索，digest 存 Redis 由 executor 任务开头自取。fire-and-forget，
    // 绝不阻塞/失败影响 dispatch。
    if (env().GROUNDING_ENABLED && latest.messageId) {
      try {
        const { maybeStartGrounding } = await import('./grounding.js');
        void maybeStartGrounding({
          chatId,
          messageId: latest.messageId,
          text: latest.textPreview ?? '',
        }).catch(() => {});
      } catch {
        /* grounding is best-effort */
      }
    }

    const r = await d.taskToGroup(chatId, {
      contentDirection,
      toneGuidance: '自然接话或干活，根据用户消息自行决定。',
      quotes: latest.messageId ? [latest.messageId] : undefined,
      relatedQuotes: relatedQuotes.length ? relatedQuotes : undefined,
      targetUserId: latest.userId && latest.userId > 0 ? latest.userId : undefined,
      messageThreadId: latest.messageThreadId,
      // autoDispatch 已在上方自带 gate（非 L0 时），taskToGroup 里别再过一次。
      skipDispatchGate: true,
    });
    if (r.taskId === 'skipped_busy') busyChatIds.add(chatId);
    else if (skipChatIds) skipChatIds.add(chatId);
  }
  return busyChatIds;
}

/** True when Heart auto-dispatch should stay quiet (busy CodeAct or recent bot reply). */
async function shouldSuppressHeartAutoDispatch(chatId: number): Promise<boolean> {
  const { shouldSuppressMetaHeartDispatch } = await import('./heart-refractory.js');
  return shouldSuppressMetaHeartDispatch(chatId);
}

/** Requeue L0/heart items that hit CodeAct busy (message not yet answered). */
async function requeueBusyL0(
  attention: AttentionItem[],
  busyChatIds: Set<number>,
): Promise<void> {
  if (busyChatIds.size === 0) return;
  const state = getGlobalState();
  const candidates = attention.filter(
    (a) => (a.layer === 'L0' || a.reason.includes('heart:')) && busyChatIds.has(a.chatId),
  );
  const toRequeue: AttentionItem[] = [];
  for (const a of candidates) {
    if (a.messageId && a.messageId > 0) {
      try {
        const { isMessageAnswered } = await import('./answered.js');
        if (await isMessageAnswered(a.chatId, a.messageId)) continue;
      } catch {
        /* fail-open */
      }
      const inflight = state
        .listTasks(a.chatId)
        .filter((t) => t.status === 'queued' || t.status === 'running')
        .some((t) => t.quoteMessageIds?.includes(a.messageId!));
      if (inflight) continue;
    }
    toRequeue.push(a);
  }
  if (!toRequeue.length) return;
  try {
    const { getAttentionAccumulator } = await import('./attention.js');
    await getAttentionAccumulator().requeue(toRequeue);
    logger.info(
      { chats: [...busyChatIds], n: toRequeue.length },
      'Meta requeued L0 Attention (chat busy)',
    );
  } catch (err) {
    logger.warn({ err }, 'Meta requeue busy L0 failed');
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
  const dispatchedChatIds = new Set<number>();
  const maps = buildAttentionMaps(attention);

  // Hard-intercept user diary asks / diary:* nudges before Meta LLM (Subagent has no journal tool).
  const workAttention = await interceptDiaryAttention(attention, {
    dispatchedChatIds,
    chatLayer: maps.chatLayer,
    defaultQuotes: maps.defaultQuotes,
    defaultTargetUserIds: maps.defaultTargetUserIds,
  });
  let codeRan = dispatchedChatIds.size > 0;

  if (workAttention.length === 0 && callbacks.length === 0) {
    return { digest: codeRan ? 'diary_intercept_only' : null, codeRan };
  }

  const workMaps = buildAttentionMaps(workAttention);

  // L0 / Heart: deterministic autoDispatch FIRST so Meta LLM cannot invent台词/结论
  // (regression: 「千雪怎么了」→ Meta 写「简单说没事或本喵在看着」).
  const earlyBusy = new Set<number>();
  const earlyL0 = workAttention.filter(
    (a) =>
      (a.layer === 'L0' || a.reason.includes('heart:')) &&
      isMetaSubagentChat(a.chatId) &&
      !dispatchedChatIds.has(a.chatId),
  );
  if (earlyL0.length > 0) {
    const busy = await autoDispatchL0(earlyL0, dispatchedChatIds, workMaps);
    for (const id of busy) earlyBusy.add(id);
    codeRan = codeRan || dispatchedChatIds.size > 0 || earlyBusy.size > 0;
    await requeueBusyL0(workAttention, earlyBusy);
  }

  // Claimed + busy chats leave Meta — busy was requeued; don't let Meta re-script.
  const metaSkipChats = new Set<number>([...dispatchedChatIds, ...earlyBusy]);
  const metaAttention = filterAttentionForMetaLlm(workAttention, metaSkipChats);

  if (metaAttention.length === 0 && callbacks.length === 0) {
    logger.info(
      {
        autoDispatched: dispatchedChatIds.size,
        busy: earlyBusy.size,
        intercepted: attention.length - workAttention.length,
      },
      'Meta session: L0 autoDispatch only (skip Meta LLM)',
    );
    return { digest: 'l0_auto_only', codeRan };
  }

  const engine = getContextEngine('meta');
  const dreaming = await loadBackgroundDreaming();

  // Resolve the dream journal channel link + numeric chatId for this session.
  let journalChannelLink: string | null = null;
  let journalChatId: number = 0;
  try {
    const info = await getJournalChannelInfo();
    if (info) {
      journalChannelLink = info.link;
      journalChatId = info.chatId;
    }
  } catch {
    /* non-critical */
  }

  // Pure ok-callbacks: CodeAct already spoke. Do not Meta-LLM another group reply
  // (was causing near-duplicate second bubbles after diary ack).
  const userFacing = metaAttention.filter((a) => a.layer === 'L0' || a.layer === 'L1');
  const onlyOkCallbacks =
    userFacing.length === 0 &&
    callbacks.length > 0 &&
    callbacks.every((c) => c.ok) &&
    metaAttention.every((a) => a.layer === 'L1_CALLBACK' || a.reason.startsWith('callback:'));
  if (onlyOkCallbacks) {
    const digest = callbacks
      .map((c) => c.summary)
      .join('; ')
      .slice(0, 240);
    if (digest) {
      state.addDigest(digest);
      persistDigest({ kind: 'meta', text: digest });
    }
    logger.info(
      { callbacks: callbacks.length, alreadyDispatched: codeRan },
      'Meta callbacks-only session skipped (no re-dispatch)',
    );
    return { digest: digest || 'callbacks_only', codeRan };
  }

  const attentionBlock = metaAttention
    .map((a) => {
      const un =
        typeof a.payload?.['username'] === 'string' && a.payload['username']
          ? `@${a.payload['username']}`
          : '';
      const master = a.userId && a.userId === env().MASTER_UID ? ' 主人' : '';
      return (
        `- [${a.layer} p=${a.pressure}] chat=${a.chatId} msg=${a.messageId ?? '-'} uid=${a.userId ?? '-'}${un ? ` ${un}` : ''}${master} reason=${a.reason}` +
        (a.textPreview ? ` text="${a.textPreview.slice(0, 120)}"` : '') +
        formatAttentionReplyToBit(a.payload)
      );
    })
    .join('\n');

  const callbackBlock =
    callbacks.length === 0
      ? '(none)'
      : callbacks
          .map((c) => `- task=${c.taskId} chat=${c.chatId} ok=${c.ok} summary=${c.summary.slice(0, 200)}`)
          .join('\n');

  // flag 开 → digest 注入改读 SQLite session_digests(全局叙事流,重启不丢);
  // flag 关 → 维持内存 40 条旧路径。SQLite 读取失败时 recentPersistedDigests 返回 []。
  const digestBlock = (
    env().DIGEST_PERSIST_ENABLED
      ? recentPersistedDigests(6).map((d) => ({ at: d.createdAt * 1000, text: d.text }))
      : state.recentDigests(6)
  )
    .map((d) => `- ${formatBeijingNowLine(new Date(d.at))} ${d.text.slice(0, 160)}`)
    .join('\n');

  const { prompt, manifest } = await engine.assemble([
    staticText('meta-system', META_SYSTEM),
    staticText('meta-persona-direction', dreaming || '（无人设方向文件）'),
    ephemeralText('meta-master', buildMasterIdentityBlock()),
    deltaText('meta-digests', `## Recent session digests\n${digestBlock || '(none)'}`),
    ephemeralText('meta-attention', `## Attention set\n${attentionBlock || '(none)'}`),
    ephemeralText('meta-callbacks', `## Callbacks\n${callbackBlock}`),
    volatileText(
      'meta-now',
      `## Now\n${formatBeijingNowLine()}\n${masterShortHint()}\nL0/Heart 多半已 autoDispatch；只编排剩余 Attention/Callbacks。tone 默认短回；看日段。Write JS if needed.`,
    ),
    ...(journalChannelLink
      ? [
          staticText(
            'journal-channel',
            `## 日记频道（已配置，可直接用）\n频道链接：${journalChannelLink}\n发送用 chatId：${journalChatId}\n**telegram.sendToChat(${journalChatId}, "内容", "图片路径") 可以直接发，bot 有权限。**`,
          ),
        ]
      : []),
  ]);

  logger.info(
    {
      attention: metaAttention.length,
      autoDispatched: dispatchedChatIds.size,
      intercepted: attention.length - workAttention.length,
      callbacks: callbacks.length,
      cacheHitRatio: Number(manifest.cacheHitRatio.toFixed(3)),
      totalChars: manifest.totalChars,
    },
    'Meta session start',
  );

  const metaMaps = buildAttentionMaps(metaAttention);

  let result;
  try {
    result = await callWithFallback({
      usage: env().META_USAGE,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content:
            '根据剩余 Attention / Callbacks 做本轮编排。L2 默认沉默；dispatch 时务必 quotes:[msgId]，contentDirection 只写短方向不写台词。只在需要时写 js。',
        },
      ],
      maxTokens: 1200,
      temperature: 0.3,
    });
  } catch (err) {
    logger.warn({ err }, 'Meta LLM failed');
    const busy = await autoDispatchL0(workAttention, dispatchedChatIds, workMaps);
    await requeueBusyL0(workAttention, busy);
    return { digest: 'meta_llm_failed_auto_l0', codeRan: true };
  }

  const text = result.content ?? '';
  const code = extractJsBlock(text);
  let aborted = false;

  if (code) {
    try {
      await runMetaCode(code, {
        dispatchedChatIds,
        isAborted: () => aborted,
        chatLayer: metaMaps.chatLayer,
        defaultQuotes: metaMaps.defaultQuotes,
        defaultTargetUserIds: metaMaps.defaultTargetUserIds,
      });
      codeRan = true;
    } catch (err) {
      logger.warn({ err }, 'Meta code exec failed');
    } finally {
      aborted = true;
    }
  }

  // Safety gap-fill: any L0/Heart still undelivered (e.g. early path missed a chat).
  const pendingL0 = workAttention.filter(
    (a) =>
      (a.layer === 'L0' || a.reason.includes('heart:')) &&
      isMetaSubagentChat(a.chatId) &&
      !dispatchedChatIds.has(a.chatId),
  );
  const busyChatIds = new Set<number>();
  if (pendingL0.length > 0) {
    const busy = await autoDispatchL0(pendingL0, dispatchedChatIds, workMaps);
    for (const id of busy) busyChatIds.add(id);
    codeRan = true;
  }
  await requeueBusyL0(workAttention, busyChatIds);

  const digest = extractDigest(text) ?? text.slice(0, 240);
  if (digest) {
    state.addDigest(digest);
    // CGM: digest 永久落 SQLite(FTS 可检索);内存/Redis 写法保持不动做兼容。
    // flag 关时 persistDigest 内部 no-op,且永不抛出。
    persistDigest({ kind: 'meta', text: digest });
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
