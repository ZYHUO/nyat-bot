import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { sendMessage, sendSticker, reactToMessage, sendChatAction } from '../bot/sender/telegram.js';
import { searchMemory, searchMemoryByUser } from '../memory/chroma.js';
import { getReadyStickersByIntent } from '../knowledge/sticker/store.js';
import { getPersonIdentity, buildCrossGroupInjection } from '../tracking/person-identity.js';
import { isDM } from '../shared/chat.js';
import { isEchoOf } from '../shared/echo-text.js';
import { markMessageAnswered } from '../meta/answered.js';
import type { ApplyOutcome, MasterActionOutcome } from '../allowlist/bot-flow.js';

/** Cross-task memory of recent bot lines in this process (beats Redis/NyatDB lag). */
const recentBotTextsByChat = new Map<number, string[]>();

function rememberBotText(chatId: number, text: string): void {
  const arr = recentBotTextsByChat.get(chatId) ?? [];
  arr.push(text);
  while (arr.length > 6) arr.shift();
  recentBotTextsByChat.set(chatId, arr);
}

function isRecentBotEcho(chatId: number, text: string): string | undefined {
  for (const prior of recentBotTextsByChat.get(chatId) ?? []) {
    if (isEchoOf(text, prior)) return prior;
  }
  return undefined;
}

/** Same wording just sent in another chat (group→DM 串台复读). */
function isCrossChatBotEcho(
  chatId: number,
  text: string,
): { otherChatId: number; prior: string } | undefined {
  for (const [cid, arr] of recentBotTextsByChat) {
    if (cid === chatId) continue;
    for (const prior of arr) {
      if (isEchoOf(text, prior)) return { otherChatId: cid, prior };
    }
  }
  return undefined;
}

/**
 * Telegram ack that stringifies safely in template literals.
 * Without this, `${await sendFile(...)}` becomes the literal "[object Object]".
 */
function makeSendAck(
  label: string,
  messageId: number,
): { messageId: number; toString(): string; [Symbol.toPrimitive](): string } {
  return {
    messageId,
    toString: () => label,
    [Symbol.toPrimitive]: () => label,
  };
}

export interface HostApi {
  telegram: {
    sendText: (text: string, replyToMessageId?: number) => Promise<{ messageId: number }>;
    sendSticker: (fileId: string) => Promise<{ messageId: number }>;
    /** Deliver a sandbox file to the user (sendDocument). Path is sandbox-relative. */
    sendFile: (path: string, caption?: string) => Promise<{ messageId: number }>;
    /** Synthesize + send a voice message (TTS). Falls back to {skipped} when TTS disabled. */
    sendVoice: (text: string) => Promise<{ messageId: number } | { skipped: true; reason: string }>;
    /**
     * 跨群送达（承诺闭环①）：把一条文字发到另一个群；可带沙盒相对路径文件
     * （券/图/报告当附件，text 变 caption）。仅主人 DM 任务可用，
     * 每任务限 2 次；目标必须是 bot 在的群。PROMISE_LOOP_ENABLED 门控。
     */
    sendToChat: (targetChatId: number, text: string, filePath?: string) => Promise<{ messageId: number }>;
    react: (messageId: number, emoji: string) => Promise<boolean>;
  };
  /** 群目录（承诺闭环配套）：按**群名片段**找群。空命中返回指路字符串（找错对象的自救提示）。 */
  chats: {
    find: (query: string) => Promise<Array<{ chatId: number; title: string }> | string>;
    /** 读另一个群的最近消息（本 bot 自己的上下文库，只读）。查「ta 回话了吗」用。 */
    recentMessages: (chatId: number, limit?: number) => Promise<string>;
  };
  /** 成员目录（2026-08-19）：按**人名/@username** 查这个人在 bot 在的哪些群、能不能私聊。 */
  members: {
    find: (
      name: string,
    ) => Promise<
      | Array<{
          uid: number;
          username: string;
          name: string;
          groups: Array<{ chatId: number; title: string }>;
          dmAvailable: boolean;
        }>
      | string
    >;
  };
  /** 关注目标（承诺闭环②）：把「等下/回头要做的事」立成 goal，unified-tick 到点执行。 */
  goals: {
    add: (
      topic: string,
      targetChatId?: number,
      checkInMinutes?: number,
    ) => Promise<{ goalId: number | null; reason: string }>;
  };
  /**
   * 群白名单（2026-08-20 bot 对话流，替代 miniapp 申请入口）。
   * apply 任何人私聊可用；approve/reject/list 仅主人 DM。ALLOWLIST_BOT_FLOW_ENABLED 门控。
   */
  allowlist: {
    /** 给群申请开通：target = 群ID(全形或去 -100 短形)/@username/t.me 链接。AI 自动审核。 */
    apply: (target: string, note?: string) => Promise<ApplyOutcome>;
    /** 主人放行待评判申请（requestId/chatId/@username/群名片段都行）。 */
    approve: (target: string) => Promise<MasterActionOutcome>;
    /** 主人拒掉待评判申请。 */
    reject: (target: string, reason?: string) => Promise<MasterActionOutcome>;
    /** 主人翻白名单记录：待评判/已通过/已拒绝 + AI 理由。 */
    list: () => Promise<string>;
  };
  memory: {
    search: (query: string) => Promise<string>;
    recallPerson: (uid: number, query: string) => Promise<string>;
    recentContext: (limit?: number) => Promise<string>;
    /** 搜 bot 自己做过的事/说过的话（session digest FTS）。查「我之前办到哪了」用。 */
    searchDigests: (query: string) => Promise<string>;
  };
  stickers: {
    pick: (mood?: string) => Promise<string | null>;
  };
  web: {
    /** Live web search (Gemini / xAI / Searx / DDG). */
    search: (query: string) => Promise<string>;
  };
  meta: {
    /**
     * Ask Meta to do something Subagent cannot (journal.*, orchestration).
     * Queues Attention for the next Meta tick; does not block for a result.
     */
    request: (args: { action: string; detail?: string }) => Promise<{ queued: boolean; action: string }>;
  };
  runtime: {
    endTask: (summary: string) => void;
    didSendText: () => boolean;
    /** 有产出（文字或文件都算）——长任务续跑判断用。 */
    didProduce: () => boolean;
    /** Await ctx/timing writes so Meta callback sees the reply. */
    flushBookkeeping: () => Promise<void>;
    /** 模型没 return 时兜底：取走本任务被忽略的查询类工具结果摘要（executor 用）。 */
    drainUnviewedResults?: () => string[];
    /** 工作记忆：记下「在等什么/答应了什么」，30 分钟自动过期。 */
    setScratch: (text: string) => Promise<void>;
    /** 事办完了清掉（prefix 匹配，省略 = 全清）。 */
    clearScratch: (prefix?: string) => Promise<void>;
  };
  /** Computer-use sandbox (terminal/browser/files). Throws sandbox_disabled when off. */
  computer: Record<string, (...args: never[]) => Promise<unknown>>;
}

/** Computer-use namespace — terminal, browser, files. Disabled proxy when SANDBOX_ENABLED=false. */
function buildComputerApi(
  noteUnviewed?: (label: string, v: unknown) => void,
): Record<string, (...args: never[]) => Promise<unknown>> {
  if (!env().SANDBOX_ENABLED) {
    // Return a proxy that throws on any property access — model gets a clear error.
    // Guard against `then` to avoid thenable trap if model writes `await computer`.
    return new Proxy({}, {
      get(_t, key) {
        if (key === 'then') return undefined;
        return () => Promise.reject(new Error('sandbox_disabled'));
      },
    }) as Record<string, (...args: never[]) => Promise<unknown>>;
  }
  return {
    async env() {
      const { getSandboxEnvInfo } = await import('../sandbox/terminal.js');
      return getSandboxEnvInfo();
    },
    async run(command: never) {
      const { executeCommand } = await import('../sandbox/terminal.js');
      const v = await executeCommand(String(command));
      noteUnviewed?.(`computer.run(${String(command).slice(0, 40)})`, v);
      return v;
    },
    async writeFile(path: never, content: never) {
      const { sandboxWriteFile } = await import('../sandbox/files.js');
      return sandboxWriteFile(String(path), String(content));
    },
    async readFile(path: never) {
      const { sandboxReadFile } = await import('../sandbox/files.js');
      return sandboxReadFile(String(path));
    },
    async listFiles(dir?: never) {
      const { sandboxListFiles } = await import('../sandbox/files.js');
      return sandboxListFiles(dir ? String(dir) : undefined);
    },
    async browse(url: never) {
      const { browserOpen } = await import('../sandbox/browser.js');
      return browserOpen(String(url));
    },
    async screenshot() {
      const { browserScreenshot } = await import('../sandbox/browser.js');
      return browserScreenshot();
    },
    async click(selector: never) {
      const { browserClick } = await import('../sandbox/browser.js');
      return browserClick(String(selector));
    },
    async type(selector: never, text: never) {
      const { browserType } = await import('../sandbox/browser.js');
      return browserType(String(selector), String(text));
    },
    async getText(selector?: never) {
      const { browserGetText } = await import('../sandbox/browser.js');
      const v = await browserGetText(selector ? String(selector) : undefined);
      noteUnviewed?.('computer.getText', v);
      return v;
    },
    async eval(js: never) {
      const { browserEval } = await import('../sandbox/browser.js');
      return browserEval(String(js));
    },
    async scroll(direction: never, amount?: never) {
      const { browserScroll } = await import('../sandbox/browser.js');
      return browserScroll(String(direction) as 'up' | 'down', amount ? Number(amount) : undefined);
    },
    async closeBrowser() {
      const { browserClose } = await import('../sandbox/browser.js');
      return browserClose();
    },
  };
}

export function createHostApi(
  chatId: number,
  opts: {
    onEnd: (summary: string) => void;
    defaultReplyTo?: number;
    /** Burst siblings - mark answered only after successful sendText. */
    relatedQuoteIds?: number[];
    isClosed?: () => boolean;
    taskId?: string;
    /** Max sendText calls (default 2; work mode may pass 5). */
    maxTextSends?: number;
    /** Max sendFile calls (default unlimited; self-play passes 1). */
    maxFileSends?: number;
    /** Telegram forum topic (supergroup thread) id; routes replies into the correct topic. */
    messageThreadId?: number;
  },
): HostApi {
  const banned = env().CODEACT_BANNED_WORDS;
  let ended = false;
  let defaultQuoteUsed = false;
  let textSent = 0;
  let fileSent = 0;
  let lastSentNorm = '';
  let metaRequested = false;
  // 承诺闭环：本任务发出过的文字（backstop 扫承诺措辞用）、跨群送达次数、是否已立 goal。
  const sentTexts: string[] = [];
  let crossSends = 0;
  let goalAdded = false;
  const maxTextSends = opts.maxTextSends ?? 2;
  const maxFileSends = opts.maxFileSends ?? Number.POSITIVE_INFINITY;
  const pendingBookkeeping: Promise<unknown>[] = [];
  /** In-flight telegram/web ops — models often forget `await` before endTask. */
  const inflightOps = new Set<Promise<unknown>>();

  /**
   * 承诺闭环③ 兜底（LLM 判定，非规则引擎）：endTask 时把本任务发出的文字交给
   * 便宜 LLM 判「bot 是不是承诺了没兑现/没登记的事」——是且模型既没 goals.add
   * 也没 sendToChat → 自动补立 goal（origin promise-backstop）。fail-soft，
   * LLM 失败就当没承诺（宁可漏，不误立）。
   */
  const promiseBackstop = async (): Promise<void> => {
    try {
      if (!env().PROMISE_LOOP_ENABLED) return;
      if (goalAdded || crossSends > 0) return;
      if (sentTexts.length === 0) return;
      const said = sentTexts.map((t) => t.slice(0, 200)).join('\n');
      const { callWithFallback } = await import('../ai/fallback.js');
      const res = await callWithFallback({
        usage: env().PROMISE_CHECK_USAGE,
        messages: [
          {
            role: 'system',
            content:
              'bot 刚刚对用户说了下面这些话。判断：bot 是否承诺了将来的动作（送去/转发/提醒/等下做/回头给…），而且这次对话里并没有完成它？普通闲聊、已经完成了的事、没承诺 → false。只输出 JSON：{"promise": true|false, "topic": "一句话事项(≤30字, promise=false 时空串)"}。topic 必须具体——谁+做什么（给某人送什么/查什么/提醒什么），「帮忙做某事」「处理事情」这类空泛写法等于没提取出来，直接判 false',
          },
          { role: 'user', content: said },
        ],
        maxTokens: 120,
        temperature: 0,
        maxTimeoutMs: 8_000,
        allowHedge: false,
      });
      const m = (res.content || '').match(/\{[\s\S]*\}/);
      if (!m) return;
      let verdict: { promise?: boolean; topic?: string };
      try {
        verdict = JSON.parse(m[0]) as { promise?: boolean; topic?: string };
      } catch {
        return;
      }
      const topic = String(verdict.topic ?? '').trim().slice(0, 60);
      if (!verdict.promise || !topic) return;
      const { createGoal } = await import('../agent/goals.js');
      const id = createGoal({
        topic: `兑现承诺: ${topic}`,
        origin: `promise-backstop:${opts.taskId ?? ''}`.slice(0, 64),
        chatId,
        checkIntervalSec: 900,
      }, env().GOAL_MAX_ACTIVE);
      if (id) {
        logger.info({ chatId, goalId: id, topic }, 'promise backstop(llm): goal created from bot own text');
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'promise backstop failed (non-critical)');
    }
  };

  const assertOpen = () => {
    if (opts.isClosed?.()) throw new Error('host_closed');
  };

  const trackInflight = <T>(p: Promise<T>): Promise<T> => {
    inflightOps.add(p);
    // Attach handler so reject-before-await (tests / fire-and-forget) isn't "unhandled"
    void p.finally(() => inflightOps.delete(p)).catch(() => undefined);
    return p;
  };

  const assertNotBanned = (text: string) => {
    const hit = banned.find((w) => w && text.includes(w));
    if (hit) throw new Error(`banned_word:${hit}`);
  };

  const parseMsgId = (raw?: number): number | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const n = typeof raw === 'string' ? Number(raw) : Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return undefined;
  };

  const resolveReplyTo = (replyToMessageId?: number): number | undefined => {
    const explicit = parseMsgId(replyToMessageId);
    const fallback = parseMsgId(opts.defaultReplyTo);

    // Task quote exists: never accept a different #id on the *first* quote fill
    // (DM used to trust model and pasted a *group* messageId → 串台).
    if (fallback) {
      if (explicit && explicit !== fallback && !defaultQuoteUsed) {
        logger.warn(
          { chatId, fromModel: explicit, forced: fallback, dm: isDM(chatId) },
          'host sendText: reject model replyTo ≠ task quote',
        );
        throw new Error(
          `reply_to_mismatch: model used #${explicit} but task quote is #${fallback}. ` +
            `Omit replyTo or pass only ${fallback}, then retry sendText (do not reuse wrong bubble text).`,
        );
      }
      // DM: never force quote (omit → plain bubble).
      if (isDM(chatId)) return explicit;
      // Group first bubble: fill task quote once.
      if (!defaultQuoteUsed) {
        defaultQuoteUsed = true;
        return fallback;
      }
      // Later sendText: default plain; only honor explicit 特别许愿 replyTo.
      return explicit;
    }

    // No task quote — DM/group: explicit only as last resort
    if (explicit && !isDM(chatId)) {
      logger.warn({ chatId, fromModel: explicit }, 'host sendText: group send with no task quote');
    }
    return explicit;
  };

  const track = (p: Promise<unknown>) => {
    pendingBookkeeping.push(p);
    return p;
  };

  /**
   * 「只回 ok」事故的机制修复（2026-08-21 goal_2：web.search 明明返回 1247 字，
   * 模型没 return → 以为工具坏了 → 向主人报「办不到」）。查询类工具的结果在这里
   * 留一份摘要；模型本步没 return 时由 executor 捡回附进 output。
   */
  const unviewedResults: string[] = [];
  const noteUnviewed = (label: string, v: unknown): void => {
    try {
      if (unviewedResults.length >= 5) return;
      const s = (typeof v === 'string' ? v : JSON.stringify(v)) || '';
      if (!s) return;
      unviewedResults.push(`${label} → ${s.slice(0, 300)}${s.length > 300 ? '…' : ''}`);
    } catch {
      /* best-effort */
    }
  };

  /** allowlist 命名空间的公共 deps 组装（apply/approve/reject/list 共用）。 */
  const buildAllowlistDeps = async () => {
    const { getBot, getBotUid } = await import('../bot/bot.js');
    const { getRedis } = await import('../db/redis.js');
    const botFlow = await import('../allowlist/bot-flow.js');
    const { callAllowlistReviewModel } = await import('../allowlist/ai-call.js');
    return {
      botFlow,
      deps: {
        redis: getRedis(),
        bot: getBot(),
        config: botFlow.configFromEnv(env()),
        aiCall: callAllowlistReviewModel,
        getRecentContext: botFlow.defaultGetRecentContext,
        masterUid: env().MASTER_UID,
        botUid: getBotUid(),
      },
    };
  };

  return {
    telegram: {
      sendText(text: string, replyToMessageId?: number) {
        assertOpen();
        return trackInflight(
          (async () => {
            if (textSent >= maxTextSends) {
              throw new Error(`sendText_limit:${maxTextSends}`);
            }
            // Models often do `sendText(\`...\${await sendFile(...)}\`)` — sendFile returns
            // `{messageId}`, and String/template coercion becomes the literal "[object Object]".
            if (text !== null && text !== undefined && typeof text !== 'string' && typeof text !== 'number') {
              throw new Error('sendText_non_string: pass plain text only; do not interpolate API return objects');
            }
            const clean = String(text ?? '').trim();
            if (!clean) throw new Error('empty text');
            if (clean.includes('[object Object]')) {
              throw new Error(
                'sendText_object_coercion: text contains "[object Object]" — sendFile/sendText return {messageId}; send the file, then describe it in a separate plain-text sendText without interpolating the return value',
              );
            }
            assertNotBanned(clean);

            // Reject parroting the user's latest line(s) — common when direction embeds user text.
            // Also reject copying the bot's own recent lines (跨任务复读「小鱼干」回怼到「病好了」).
            const localHit = isRecentBotEcho(chatId, clean);
            if (localHit) {
              logger.info(
                { chatId, preview: clean.slice(0, 60), prior: localHit.slice(0, 60) },
                'host sendText rejected self-echo (local)',
              );
              throw new Error('echo_self_text');
            }
            const crossHit = isCrossChatBotEcho(chatId, clean);
            if (crossHit) {
              logger.info(
                {
                  chatId,
                  otherChatId: crossHit.otherChatId,
                  preview: clean.slice(0, 60),
                  prior: crossHit.prior.slice(0, 60),
                },
                'host sendText rejected self-echo (cross-chat)',
              );
              throw new Error('echo_self_text');
            }
            try {
              const { getRecent } = await import('../pipeline/context/manager.js');
              // Wide window: dual-write holes + busy groups push prior bot lines out of 16.
              const recent = await getRecent(chatId, 80);
              const userLines = recent
                .filter((m) => m.role !== 'assistant')
                .slice(-4)
                .map((m) => String(m.textContent ?? '').trim())
                .filter(Boolean);
              if (userLines.some((u) => isEchoOf(clean, u))) {
                logger.info({ chatId, preview: clean.slice(0, 60) }, 'host sendText rejected echo');
                throw new Error('echo_user_text');
              }
              const botLines = recent
                .filter((m) => m.role === 'assistant')
                .slice(-12)
                .map((m) => String(m.textContent ?? '').trim())
                .filter((t) => t.replace(/\s+/g, '').length >= 6);
              const hitSelf = botLines.find((b) => isEchoOf(clean, b));
              if (hitSelf) {
                logger.info(
                  { chatId, preview: clean.slice(0, 60), prior: hitSelf.slice(0, 60) },
                  'host sendText rejected self-echo',
                );
                throw new Error('echo_self_text');
              }
              try {
                const { checkNearDuplicate } = await import('../pipeline/reply/anti-repeat.js');
                const dup = await checkNearDuplicate(chatId, clean);
                if (dup.isNearDuplicate) {
                  logger.info(
                    {
                      chatId,
                      preview: clean.slice(0, 60),
                      ratio: dup.ratio,
                      prior: dup.collidedWith?.slice(0, 60),
                    },
                    'host sendText rejected near-dup self',
                  );
                  throw new Error('echo_self_text');
                }
              } catch (err) {
                if (err instanceof Error && err.message === 'echo_self_text') throw err;
              }
            } catch (err) {
              if (
                err instanceof Error &&
                (err.message === 'echo_user_text' || err.message === 'echo_self_text')
              ) {
                throw err;
              }
              /* context optional */
            }

            // 同一任务里连发两条几乎一样的（「催什么催」+「催什么催嘛喵」）——拒第二条
            if (lastSentNorm && isEchoOf(clean, lastSentNorm)) {
              logger.info({ chatId, preview: clean.slice(0, 60) }, 'host sendText rejected near-dup');
              throw new Error('near_dup_reply');
            }

            // MaiBot-style split (same segmenter as legacy reply). One sendText may
            // become multiple bubbles; only the first carries reply-to.
            const maxLen = chatId > 0 ? 280 : 160;
            let parts: string[] = [clean];
            try {
              const { segmentReply, REPLY_SPLIT_CHAR_THRESHOLD } = await import(
                '../pipeline/reply/segmenter.js'
              );
              if (clean.length > REPLY_SPLIT_CHAR_THRESHOLD) {
                const { segments } = segmentReply(clean);
                if (segments.length > 1) {
                  parts = segments.map((s) => s.trim()).filter(Boolean);
                  logger.info({ chatId, n: parts.length, chars: clean.length }, 'host sendText segmented');
                }
              }
            } catch (err) {
              logger.debug({ err, chatId }, 'host segmentReply failed — single bubble');
            }
            if (parts.length === 1 && clean.length > maxLen) {
              const { softTruncate } = await import('../shared/soft-truncate.js');
              const next = softTruncate(clean, maxLen);
              logger.info({ chatId, from: clean.length, to: next.length }, 'host sendText truncated');
              parts = [next || clean.slice(0, maxLen)];
            } else if (parts.length > 1) {
              const { softTruncate } = await import('../shared/soft-truncate.js');
              parts = parts.map((p) => (p.length > maxLen ? softTruncate(p, maxLen) || p.slice(0, maxLen) : p));
            }

            // Past gate: finish even if task closes (model often skips await before endTask).
            let lastMessageId = 0;
            let firstReplyTo: number | undefined;
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]!;
              if (i > 0) {
                try {
                  const { calculateTypingDelay } = await import('../pipeline/reply/segmenter.js');
                  const sec = Math.min(1.2, calculateTypingDelay(part));
                  if (sec >= 0.05) {
                    await new Promise((r) => setTimeout(r, Math.round(sec * 1000)));
                  }
                } catch {
                  await new Promise((r) => setTimeout(r, 300));
                }
              }
              await sendChatAction(chatId, 'typing');
              // 分句：仅首条带 reply_to；后续默认不带。另一次 sendText 若显式传 messageId 才 quote（特别许愿）。
              const replyTo = i === 0 ? resolveReplyTo(replyToMessageId) : undefined;
              if (i === 0) firstReplyTo = replyTo;
              if (i === 0 && chatId < 0 && !replyTo && !opts.defaultReplyTo) {
                logger.warn({ chatId }, 'host sendText: group send without reply_to anchor');
              } else if (i === 0) {
                logger.info(
                  {
                    chatId,
                    replyTo: replyTo ?? null,
                    fromModel: replyToMessageId ?? null,
                    fallback: opts.defaultReplyTo ?? null,
                    dmNoDefault: isDM(chatId),
                    parts: parts.length,
                    preview: part.slice(0, 80),
                  },
                  'host sendText',
                );
              } else {
                logger.info(
                  { chatId, part: i + 1, of: parts.length, replyTo: null, preview: part.slice(0, 60) },
                  'host sendText continuation',
                );
              }
              const messageId = await sendMessage(chatId, part, replyTo, opts.messageThreadId);
              lastMessageId = messageId;
              lastSentNorm = part;
              sentTexts.push(part);
              rememberBotText(chatId, part);
              // G8 A/B 基线:Meta/CodeAct 是生产的主回复路径,它不经过
              // stages/deliver.ts,所以那边的埋点在这条路上完全记不到(实测
              // decision_reply=16 而 reply_sent=0)。这里不带端到端耗时 ——
              // Meta 的任务边界与"收到消息→发出回复"不是同一个跨度,
              // 硬凑一个口径不一致的延迟比没有更糟。
              void import('../metrics/social-ledger.js')
                .then(({ recordReplySent }) => recordReplySent(chatId))
                .catch(() => { /* telemetry never breaks delivery */ });
              await track(
                import('../pipeline/context/manager.js')
                  .then(({ addAssistant }) => addAssistant(chatId, { textContent: part, messageId }, opts.messageThreadId))
                  .catch((err) => logger.debug({ err, chatId }, 'host addAssistant failed')),
              );
              void import('../memory/chroma.js')
                .then(({ memorizeMessage }) =>
                  memorizeMessage(chatId, {
                    role: 'assistant',
                    uid: 0,
                    username: '',
                    fullName: '',
                    timestamp: Math.floor(Date.now() / 1000),
                    messageId,
                    textContent: part,
                    isForwarded: false,
                  }),
                )
                .catch((err) => logger.debug({ err, chatId }, 'host memorize assistant failed'));
            }

            textSent += 1;

            const answeredIds = new Set<number>();
            // Only mark after successful send — never a stale fromModel id.
            if (firstReplyTo) answeredIds.add(firstReplyTo);
            if (opts.defaultReplyTo && opts.defaultReplyTo > 0) answeredIds.add(opts.defaultReplyTo);
            for (const mid of opts.relatedQuoteIds ?? []) {
              if (mid > 0) answeredIds.add(mid);
            }
            // 必须 await：否则 endTask → Meta 下一 tick 时 answered 还没写上，会双回
            await Promise.all(
              [...answeredIds].map((mid) => markMessageAnswered(chatId, mid).catch(() => undefined)),
            );

            // Critical path: timing must land before Meta callback.
            await track(
              import('../meta/timing-adapter.js')
                .then(({ noteMetaBotReply }) => noteMetaBotReply(chatId))
                .catch((err) => logger.debug({ err, chatId }, 'host noteMetaBotReply failed')),
            );

            // Post-task 发酵窗口:bot 发言成功 → 开窗/顺延(内部 fail-soft,绝不影响发送)。
            try {
              const { noteBotSpoke } = await import('./post-task-window.js');
              noteBotSpoke(chatId, {
                messageId: lastMessageId,
                textPreview: clean.slice(0, 200),
                taskId: opts.taskId,
                messageThreadId: opts.messageThreadId,
              });
            } catch (err) {
              logger.debug({ err, chatId }, 'host post-task noteBotSpoke failed');
            }

            return makeSendAck(`text_sent#${lastMessageId}`, lastMessageId);
          })(),
        );
      },
      sendSticker(fileId: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            const id = String(fileId ?? '').trim();
            if (!id || id.length < 8 || /[\s<>"'`]/.test(id)) {
              logger.warn({ chatId, fileId: id.slice(0, 40) }, 'host sendSticker rejected bad fileId');
              return { messageId: 0 };
            }
            await sendChatAction(chatId, 'typing');
            try {
              const messageId = await sendSticker(chatId, id);
              if (messageId > 0) {
                await track(
                  import('../pipeline/context/manager.js')
                    .then(({ addAssistant }) =>
                      addAssistant(chatId, { textContent: '[sticker]', messageId }, opts.messageThreadId),
                    )
                    .catch((err) => logger.debug({ err, chatId }, 'host addAssistant sticker failed')),
                );
                // Sticker-only reply still counts as handling the task quote.
                const answeredIds = new Set<number>();
                if (opts.defaultReplyTo && opts.defaultReplyTo > 0) answeredIds.add(opts.defaultReplyTo);
                for (const mid of opts.relatedQuoteIds ?? []) {
                  if (mid > 0) answeredIds.add(mid);
                }
                await Promise.all(
                  [...answeredIds].map((mid) => markMessageAnswered(chatId, mid).catch(() => undefined)),
                );
                // Post-task 发酵窗口:贴纸也算 bot 发了言(弱锚点, judge 会偏保守)。
                try {
                  const { noteBotSpoke } = await import('./post-task-window.js');
                  noteBotSpoke(chatId, {
                    messageId,
                    textPreview: '[sticker]',
                    taskId: opts.taskId,
                    messageThreadId: opts.messageThreadId,
                  });
                } catch (err) {
                  logger.debug({ err, chatId }, 'host post-task noteBotSpoke(sticker) failed');
                }
              }
              return { messageId };
            } catch (err) {
              logger.warn({ err, chatId }, 'host sendSticker failed (non-fatal)');
              return { messageId: 0 };
            }
          })(),
        );
      },
      sendFile(path: string, caption?: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            if (fileSent >= maxFileSends) {
              throw new Error(`sendFile_limit:${maxFileSends}`);
            }
            const raw = String(path ?? '').trim();
            if (!raw) {
              logger.warn({ chatId }, 'host sendFile rejected empty path');
              return makeSendAck('file_send_failed:empty_path', 0);
            }
            try {
              const { resolveInsideSandbox } = await import('../sandbox/paths.js');
              const { basename } = await import('node:path');
              const target = resolveInsideSandbox(raw); // throws on path escape
              const { sendFile: tgSendFile } = await import('../bot/sender/telegram.js');
              await sendChatAction(chatId, 'upload_photo');
              const { messageId } = await tgSendFile(chatId, target, {
                caption: caption ? String(caption).slice(0, 1000) : undefined,
                replyToId: opts.defaultReplyTo,
                messageThreadId: opts.messageThreadId,
              });
              if (messageId > 0) {
                fileSent++;
                await track(
                  import('../pipeline/context/manager.js')
                    .then(({ addAssistant }) =>
                      addAssistant(
                        chatId,
                        { textContent: `[file] ${basename(target)}${caption ? `: ${String(caption).slice(0, 80)}` : ''}`, messageId },
                        opts.messageThreadId,
                      ),
                    )
                    .catch((err) => logger.debug({ err, chatId }, 'host addAssistant file failed')),
                );
                const answeredIds = new Set<number>();
                if (opts.defaultReplyTo && opts.defaultReplyTo > 0) answeredIds.add(opts.defaultReplyTo);
                for (const mid of opts.relatedQuoteIds ?? []) {
                  if (mid > 0) answeredIds.add(mid);
                }
                await Promise.all(
                  [...answeredIds].map((mid) => markMessageAnswered(chatId, mid).catch(() => undefined)),
                );
              }
              // toString/toPrimitive: template `${await sendFile(...)}` must not become "[object Object]".
              return makeSendAck(messageId > 0 ? `file_sent:${basename(target)}#${messageId}` : 'file_send_failed', messageId);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn({ err, chatId, path: raw }, 'host sendFile failed (non-fatal)');
              return makeSendAck(`file_send_failed:${msg}`, 0);
            }
          })(),
        );
      },
      sendVoice(text: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            const clean = String(text ?? '').trim();
            if (!clean) return { skipped: true as const, reason: 'empty_text' };
            try {
              const { synthesizeVoice } = await import('../ai/tts.js');
              const { sendVoice: tgSendVoice } = await import('../bot/sender/telegram.js');
              const ogg = await synthesizeVoice(clean.slice(0, 500));
              if (!ogg) return { skipped: true as const, reason: 'tts_disabled' };
              await sendChatAction(chatId, 'record_voice');
              const { messageId } = await tgSendVoice(chatId, ogg, {
                replyToId: opts.defaultReplyTo,
                messageThreadId: opts.messageThreadId,
              });
              if (messageId > 0) {
                await track(
                  import('../pipeline/context/manager.js')
                    .then(({ addAssistant }) =>
                      addAssistant(chatId, { textContent: `[voice] ${clean.slice(0, 60)}`, messageId }, opts.messageThreadId),
                    )
                    .catch((err) => logger.debug({ err, chatId }, 'host addAssistant voice failed')),
                );
              }
              return { messageId };
            } catch (err) {
              logger.warn({ err, chatId }, 'host sendVoice failed — fall back to text');
              return { skipped: true as const, reason: 'tts_error' };
            }
          })(),
        );
      },
      react(messageId: number, emoji: string) {
        assertOpen();
        return trackInflight(reactToMessage(chatId, messageId, emoji));
      },
      sendToChat(targetChatId: number, text: string, filePath?: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            if (!env().PROMISE_LOOP_ENABLED) throw new Error('promise_loop_disabled');
            // v1 安全闸：只有主人 DM 里的任务可以跨群送达（主人指派的递送场景）。
            if (chatId !== env().MASTER_UID) throw new Error('sendToChat_master_dm_only');
            const tid = Number(targetChatId);
            if (!Number.isFinite(tid) || tid === 0) {
              throw new Error('sendToChat_invalid_target: group chatId (negative) or user uid (positive) required');
            }
            if (crossSends >= 2) throw new Error('sendToChat_limit:2');
            const clean = String(text ?? '').trim();
            if (!clean) throw new Error('empty text');
            assertNotBanned(clean);
            // 确认目标可达：群→bot 必须在；个人→必须已有私聊（getChat 成功）。
            try {
              const { getBot } = await import('../bot/bot.js');
              await getBot().api.getChat(tid);
            } catch {
              throw new Error(
                tid > 0
                  ? 'sendToChat_dm_unavailable: no existing DM with that user'
                  : 'sendToChat_not_member: bot is not in that group',
              );
            }
            // 可带沙盒文件：券/图/报告当附件发（text 变 caption），否则纯文字。
            let messageId = 0;
            let deliveredDesc = clean;
            const rawPath = String(filePath ?? '').trim();
            if (rawPath) {
              const { resolveInsideSandbox } = await import('../sandbox/paths.js');
              const { basename } = await import('node:path');
              const target = resolveInsideSandbox(rawPath); // throws on path escape
              const { sendFile: tgSendFile } = await import('../bot/sender/telegram.js');
              await sendChatAction(tid, 'upload_document');
              const r = await tgSendFile(tid, target, { caption: clean.slice(0, 1000) });
              messageId = r.messageId;
              deliveredDesc = `[file] ${basename(target)}: ${clean}`;
            } else {
              messageId = await sendMessage(tid, clean.slice(0, 500));
            }
            crossSends++;
            // 目标群上下文/记忆/时间线全跟上——说过的话自己得记得。
            try {
              const { addAssistant } = await import('../pipeline/context/manager.js');
              await addAssistant(tid, { textContent: deliveredDesc, messageId });
            } catch (err) {
              logger.debug({ err, chatId: tid }, 'host sendToChat addAssistant failed');
            }
            try {
              const { noteMetaBotReply } = await import('../meta/timing-adapter.js');
              await noteMetaBotReply(tid);
            } catch (err) {
              logger.debug({ err, chatId: tid }, 'host sendToChat noteMetaBotReply failed');
            }
            try {
              const { persistDigest } = await import('../meta/session-digest.js');
              persistDigest({
                kind: 'subagent',
                sourceChatId: tid,
                taskId: opts.taskId,
                text: `跨群送达(${chatId}→${tid}): ${deliveredDesc.slice(0, 80)}`,
              });
            } catch (err) {
              logger.debug({ err, chatId: tid }, 'host sendToChat digest failed');
            }
            logger.info(
              { from: chatId, to: tid, messageId, withFile: !!rawPath, preview: clean.slice(0, 60) },
              'host sendToChat delivered',
            );
            return makeSendAck(`cross_sent#${messageId}`, messageId);
          })(),
        );
      },
    },
    chats: {
      async find(query: string) {
        const q = String(query ?? '').trim().slice(0, 50);
        if (!q) return [];
        const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
        const nq = norm(q);
        if (!nq) return [];
        const { getRedis } = await import('../db/redis.js');
        const redis = getRedis();
        let ids: number[] = [];
        try {
          const raw = await redis.zrange('xxb:active_groups', 0, 39);
          ids = [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n < 0))];
        } catch {
          return [];
        }
        const out: Array<{ chatId: number; title: string }> = [];
        for (const id of ids) {
          let title = '';
          try {
            const cached = await redis.get(`xxb:chat_title:${id}`);
            if (cached) {
              title = cached;
            } else {
              const { getBot } = await import('../bot/bot.js');
              const chat = (await getBot().api.getChat(id)) as { title?: string };
              title = typeof chat.title === 'string' ? chat.title : '';
              if (title) await redis.set(`xxb:chat_title:${id}`, title, 'EX', 21600);
            }
          } catch {
            continue; // 已退群/不可达——跳过
          }
          const nt = norm(title);
          if (nt && (nt.includes(nq) || nq.includes(nt))) {
            out.push({ chatId: id, title });
            if (out.length >= 3) break;
          }
        }
        logger.info({ chatId, query: q, candidates: ids.length, hits: out.length }, 'host chats.find');
        // 空命中时给指路而不是裸 []——模型拿「群名查不到」当「这个人不存在」用是
        // 2026-08-19 的实测事故（找 ccb 却调了群名搜索）。
        if (out.length === 0) {
          return `群名里没查到「${q}」。注意：chats.find 是按**群名**找群；如果你要找的是**某个人**（ta 在哪些群/能不能私聊），用 members.find(名字)。`;
        }
        noteUnviewed(`chats.find(${q.slice(0, 30)})`, out);
        return out;
      },
      async recentMessages(targetChatId: number, limit = 12) {
        const tid = Number(targetChatId);
        if (!Number.isFinite(tid) || tid === 0) return '(invalid chatId)';
        const n = Math.min(Math.max(Number(limit) || 12, 1), 30);
        try {
          const { getRecent } = await import('../pipeline/context/manager.js');
          const { slimSingleMessage } = await import('../pipeline/context/slim.js');
          const { getBotUid } = await import('../bot/bot.js');
          const msgs = await getRecent(tid, n);
          if (!msgs.length) return '(那个群最近没有记录)';
          const botUid = getBotUid() || 0;
          const text = msgs.map((m) => slimSingleMessage(m, botUid)).join('\n');
          noteUnviewed(`chats.recentMessages(${tid})`, text);
          return text;
        } catch (err) {
          logger.debug({ err, chatId: tid }, 'host chats.recentMessages failed');
          return '(读取失败)';
        }
      },
    },
    members: {
      async find(name: string) {
        const q = String(name ?? '').trim().replace(/^@/, '').slice(0, 40);
        if (!q) return [];
        // 1) SQLite 画像：bot 在哪些群见过这个人（免费本地查询）
        const { getDb } = await import('../db/sqlite.js');
        const like = `%${q}%`;
        const rows = getDb()
          .prepare(
            `SELECT chat_id, uid, username, full_name, sender_tag FROM user_profiles
             WHERE username LIKE ? OR full_name LIKE ? OR sender_tag LIKE ? LIMIT 30`,
          )
          .all(like, like, like) as Array<{
          chat_id: number; uid: number; username: string | null; full_name: string | null; sender_tag: string | null;
        }>;
        const byUid = new Map<number, { username: string; name: string; chatIds: number[] }>();
        for (const r of rows) {
          if (!(r.uid > 0)) continue;
          const cur = byUid.get(r.uid) ?? { username: r.username ?? '', name: r.full_name ?? '', chatIds: [] };
          if (!cur.username && r.username) cur.username = r.username;
          if (!cur.name && r.full_name) cur.name = r.full_name;
          if (!cur.chatIds.includes(r.chat_id)) cur.chatIds.push(r.chat_id);
          byUid.set(r.uid, cur);
        }
        const { getRedis } = await import('../db/redis.js');
        const redis = getRedis();
        const resolveTitle = async (cid: number): Promise<string> => {
          try {
            const cached = await redis.get(`xxb:chat_title:${cid}`);
            if (cached) return cached;
            const { getBot } = await import('../bot/bot.js');
            const chat = (await getBot().api.getChat(cid)) as { title?: string };
            const t = typeof chat.title === 'string' ? chat.title : '';
            if (t) await redis.set(`xxb:chat_title:${cid}`, t, 'EX', 21600);
            return t;
          } catch {
            return '';
          }
        };
        const out: Array<{
          uid: number; username: string; name: string;
          groups: Array<{ chatId: number; title: string }>; dmAvailable: boolean;
        }> = [];
        for (const [uid, info] of [...byUid.entries()].slice(0, 3)) {
          // 2) 逐群确认当前成员身份（cap 6），顺带解析标题
          const { getBot } = await import('../bot/bot.js');
          const groups: Array<{ chatId: number; title: string }> = [];
          for (const cid of info.chatIds.slice(0, 6)) {
            try {
              const m = (await getBot().api.getChatMember(cid, uid)) as { status?: string };
              if (m.status === 'left' || m.status === 'kicked') continue;
              groups.push({ chatId: cid, title: await resolveTitle(cid) });
            } catch {
              continue; // 退群/不可达
            }
          }
          // 3) DM 可达性（对方和 bot 有过私聊才发得起 DM）
          let dmAvailable = false;
          try {
            await getBot().api.getChat(uid);
            dmAvailable = true;
          } catch {
            /* no DM history */
          }
          out.push({ uid, username: info.username, name: info.name, groups, dmAvailable });
        }
        logger.info({ chatId, query: q, candidates: byUid.size, hits: out.length }, 'host members.find');
        if (out.length === 0) {
          return `本地画像里没找到「${q}」——ta 可能没在本喵见过的群里说过话，或名字写法不一样（试试 ta 的 @username 或群友常用叫法）。实在没有就请主人给 ta 的 uid，或把 ta 拉来跟本喵说句话。`;
        }
        noteUnviewed(`members.find(${q.slice(0, 30)})`, out);
        return out;
      },
    },
    goals: {
      async add(topic: string, targetChatId?: number, checkInMinutes?: number) {
        if (!env().PROMISE_LOOP_ENABLED) return { goalId: null, reason: 'promise_loop_disabled' };
        const t = String(topic ?? '').trim().slice(0, 100);
        if (!t) return { goalId: null, reason: 'empty_topic' };
        const cid = Number(targetChatId);
        const goalChatId = Number.isFinite(cid) && cid !== 0 ? cid : chatId;
        const minutes = Number(checkInMinutes);
        const intervalSec = Math.min(Math.max(Number.isFinite(minutes) && minutes > 0 ? minutes : 15, 5), 1440) * 60;
        const { createGoal } = await import('../agent/goals.js');
        const id = createGoal({
          topic: t,
          origin: `promise:${opts.taskId ?? 'chat'}`.slice(0, 64),
          chatId: goalChatId,
          checkIntervalSec: intervalSec,
        }, env().GOAL_MAX_ACTIVE);
        if (id) {
          goalAdded = true;
          logger.info({ chatId, goalChatId, goalId: id, topic: t }, 'host goals.add (promise)');
        }
        return { goalId: id, reason: id ? 'created' : 'dup_or_full' };
      },
    },
    allowlist: {
      async apply(target: string, note?: string) {
        assertOpen();
        if (!env().ALLOWLIST_BOT_FLOW_ENABLED) throw new Error('allowlist_bot_flow_disabled');
        // 申请只能私聊发起：DM 的 chatId 就是申请人 uid，天然实名可追溯。
        if (!(chatId > 0)) {
          throw new Error('allowlist_apply_dm_only: 请对方私聊我，把群 ID 或 @username 发过来申请');
        }
        const { botFlow, deps } = await buildAllowlistDeps();
        let applicantUsername: string | undefined;
        let applicantFirstName: string | undefined;
        try {
          const u = (await deps.bot.api.getChat(chatId)) as {
            username?: string;
            first_name?: string;
          };
          applicantUsername = u.username;
          applicantFirstName = u.first_name;
        } catch {
          /* best-effort */
        }
        const outcome = await botFlow.applyViaBot(deps, {
          applicantUid: chatId,
          applicantUsername,
          applicantFirstName,
          target: String(target ?? ''),
          note: note === undefined || note === null ? undefined : String(note),
        });
        logger.info({ chatId, target: String(target ?? ''), outcome: outcome.kind }, 'host allowlist.apply');
        return outcome;
      },
      async approve(target: string) {
        assertOpen();
        if (!env().ALLOWLIST_BOT_FLOW_ENABLED) throw new Error('allowlist_bot_flow_disabled');
        if (chatId !== env().MASTER_UID) throw new Error('allowlist_master_only');
        const { botFlow, deps } = await buildAllowlistDeps();
        const outcome = await botFlow.masterApprove(deps, String(target ?? ''));
        logger.info({ chatId, target: String(target ?? ''), outcome: outcome.kind }, 'host allowlist.approve');
        return outcome;
      },
      async reject(target: string, reason?: string) {
        assertOpen();
        if (!env().ALLOWLIST_BOT_FLOW_ENABLED) throw new Error('allowlist_bot_flow_disabled');
        if (chatId !== env().MASTER_UID) throw new Error('allowlist_master_only');
        const { botFlow, deps } = await buildAllowlistDeps();
        const outcome = await botFlow.masterReject(
          deps,
          String(target ?? ''),
          reason === undefined || reason === null ? undefined : String(reason),
        );
        logger.info({ chatId, target: String(target ?? ''), outcome: outcome.kind }, 'host allowlist.reject');
        return outcome;
      },
      async list() {
        assertOpen();
        if (!env().ALLOWLIST_BOT_FLOW_ENABLED) throw new Error('allowlist_bot_flow_disabled');
        if (chatId !== env().MASTER_UID) throw new Error('allowlist_master_only');
        const { botFlow, deps } = await buildAllowlistDeps();
        const out = await botFlow.listForMaster(deps);
        noteUnviewed('allowlist.list', out);
        return out;
      },
    },
    memory: {
      async search(query: string) {
        try {
          const hits = await searchMemory(chatId, String(query).slice(0, 200), 5, 1500);
          if (!hits.length) return '(no hits)';
          const text = hits
            .map((h, i) => `${i + 1}. ${String(h.textContent ?? '').slice(0, 200)}`)
            .join('\n');
          noteUnviewed(`memory.search(${String(query).slice(0, 30)})`, text);
          return text;
        } catch (err) {
          logger.debug({ err }, 'host memory.search failed');
          return '(memory unavailable)';
        }
      },
      async recallPerson(uid: number, query: string) {
        const id = Number(uid);
        if (!Number.isFinite(id) || id <= 0) return '(invalid uid)';
        const bits: string[] = [];
        try {
          const ident = getPersonIdentity(id);
          if (ident?.impression) bits.push(`impression: ${ident.impression}`);
          const inj = buildCrossGroupInjection(id, chatId);
          if (inj) bits.push(inj);
        } catch { /* optional */ }
        // 跨上下文召回的 fail-closed 守卫已收口进 searchMemoryByUser 本身(双 flag),
        // 这里再显式判一次只为给模型一个明确信号 —— 否则它拿到空结果会反复重试。
        const e = env();
        if (!e.MEMORY_CROSS_CONTEXT_ENABLED || !e.MEMORY_VISIBILITY_ENABLED) {
          return bits.join('\n') || '(cross-context recall disabled)';
        }
        try {
          const hits = await searchMemoryByUser(id, String(query || '最近').slice(0, 200), chatId, 5, 2000);
          if (hits.length) {
            bits.push(
              'memories:\n' +
                hits.map((h, i) => `${i + 1}. ${String(h.textContent ?? '').slice(0, 180)}`).join('\n'),
            );
          }
        } catch (err) {
          logger.debug({ err }, 'host memory.recallPerson failed');
        }
        const joined = bits.join('\n') || '(no person recall)';
        noteUnviewed(`memory.recallPerson(${id})`, joined);
        return joined;
      },
      async recentContext(limit = 20) {
        try {
          const { getRecent } = await import('../pipeline/context/manager.js');
          const { slimSingleMessage } = await import('../pipeline/context/slim.js');
          const { getBotUid } = await import('../bot/bot.js');
          const msgs = await getRecent(chatId, limit, opts.messageThreadId);
          if (!msgs.length) return '(empty)';
          const botUid = getBotUid() || 0;
          const masterUid = env().MASTER_UID;
          const lines = msgs.map((m) => {
            const base = slimSingleMessage(m, botUid);
            if (m.role !== 'assistant' && m.uid > 0) {
              const tags: string[] = [`uid:${m.uid}`];
              if (masterUid && m.uid === masterUid) tags.push('主人');
              return `${base}  ⟨${tags.join(' ')}⟩`;
            }
            return base;
          });
          const joined = lines.join('\n');
          noteUnviewed('memory.recentContext', joined);
          return joined;
        } catch {
          return '(context unavailable)';
        }
      },
      async searchDigests(query: string) {
        const q = String(query ?? '').trim().slice(0, 80);
        if (!q) return '(empty query)';
        try {
          if (!env().DIGEST_PERSIST_ENABLED) return '(digest persist disabled)';
          const { searchDigests } = await import('../meta/session-digest.js');
          const hits = searchDigests(q, 5);
          if (!hits.length) return '(没有找到相关记录)';
          const text = hits.map((h) => `- ${h.text.slice(0, 160)}`).join('\n');
          noteUnviewed(`memory.searchDigests(${q.slice(0, 30)})`, text);
          return text;
        } catch (err) {
          logger.debug({ err, chatId }, 'host memory.searchDigests failed');
          return '(检索失败)';
        }
      },
    },
    stickers: {
      async pick(mood = 'happy') {
        try {
          const cands = getReadyStickersByIntent(mood);
          if (!cands.length) return null;
          return cands[0]!.fileId;
        } catch {
          return null;
        }
      },
    },
    web: {
      async search(query: string) {
        assertOpen();
        if (!env().CODEACT_WEB_SEARCH_ENABLED) return '(web search disabled)';
        const q = String(query ?? '').trim().slice(0, 200);
        if (!q) throw new Error('empty query');
        try {
          const { executeSearch } = await import('../pipeline/tools/search.js');
          const raw = await executeSearch(q);
          const out = String(raw ?? '').trim().slice(0, 3500);
          logger.info({ chatId, q: q.slice(0, 80), chars: out.length }, 'host web.search');
          noteUnviewed(`web.search(${q.slice(0, 40)})`, out || '(no results)');
          return out || '(no results)';
        } catch (err) {
          logger.warn({ err, chatId, q: q.slice(0, 80) }, 'host web.search failed');
          return `搜索失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    meta: {
      async request(args: { action: string; detail?: string }) {
        assertOpen();
        if (metaRequested) {
          return { queued: false, action: String(args?.action ?? '').slice(0, 64) || 'dup' };
        }
        const action = String(args?.action ?? '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._:-]/g, '')
          .slice(0, 64);
        if (!action) throw new Error('meta.request action required');
        // 2026-08-19 事故：模型编造 list_chats action 拿到 {queued:true} 正反馈，
        // 以为"系统会处理"→ 告诉用户"都试了"。未知 action 必须硬报错并指路正确工具，
        // 否则幻觉被正向强化。有效 action 只有 journal.*（系统硬处理）。
        const VALID = new Set(['journal.write', 'journal.trywrite', 'journal.recent']);
        if (!VALID.has(action)) {
          throw new Error(
            `unknown_action:${action} — meta.request 只支持 ${[...VALID].join('/')}。` +
              `找群用 chats.find(群名片段)，跨群发送用 telegram.sendToChat(chatId, text)，别编 action。`,
          );
        }
        const detail = String(args?.detail ?? '').trim().slice(0, 500);
        const { getAttentionAccumulator } = await import('../meta/attention.js');
        await getAttentionAccumulator().ingestAsync({
          chatId,
          layer: 'L0',
          pressure: 95,
          reason: `subagent_request:${action}`,
          messageId: opts.defaultReplyTo,
          textPreview: detail || action,
          payload: {
            action,
            detail,
            source: 'subagent',
            taskId: opts.taskId ?? null,
          },
        });
        metaRequested = true;
        logger.info({ chatId, action, taskId: opts.taskId }, 'host meta.request');
        return { queued: true, action };
      },
    },
    runtime: {
      endTask(summary: string) {
        if (ended) return;
        ended = true;
        // 承诺闭环③ 兜底：说了「等下/我去…」但没立 goal 也没跨群送达 → 自动补 goal。
        void promiseBackstop();
        opts.onEnd(String(summary ?? '').slice(0, 1000));
      },
      didSendText() {
        return textSent > 0;
      },
      /** 有产出（文字或文件都算）——长任务续跑判断用。 */
      didProduce() {
        return textSent > 0 || fileSent > 0;
      },
      async flushBookkeeping() {
        // Drain until idle — fire-and-forget sends may still be registering.
        for (let i = 0; i < 8; i++) {
          const ops = [...inflightOps];
          const books = pendingBookkeeping.splice(0, pendingBookkeeping.length);
          if (!ops.length && !books.length) return;
          await Promise.allSettled([...ops, ...books]);
        }
      },
      async setScratch(text: string) {
        try {
          const { setScratch } = await import('../tracking/scratchpad.js');
          await setScratch(chatId, text);
        } catch (err) {
          logger.debug({ err, chatId }, 'host setScratch failed');
        }
      },
      async clearScratch(prefix?: string) {
        try {
          const { clearScratch } = await import('../tracking/scratchpad.js');
          await clearScratch(chatId, prefix);
        } catch (err) {
          logger.debug({ err, chatId }, 'host clearScratch failed');
        }
      },
      drainUnviewedResults() {
        return unviewedResults.splice(0, unviewedResults.length);
      },
    },
    computer: buildComputerApi(noteUnviewed),
  };
}
