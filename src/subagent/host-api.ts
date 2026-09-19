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
import { appendCognitiveEvent } from '../agent/cognitive-events.js';
import { recordPrediction } from '../agent/predictions.js';
import { recordSocialDeliveryPrediction } from '../agent/social-predictions.js';

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

/**
 * 连发事实注记：同一任务里距上一条发出仅 gapSec 秒时，sendText 回执里附一句
 * 人话事实，让模型自己意识到在刷屏/同义改写。不拦截——只报事实，说不说由它决定。
 * gapSec 为 null（本任务第一条）时不加注记。导出走纯函数是为了可单测。
 */
export function buildPacingAckSuffix(gapSec: number | null): string {
  if (gapSec === null || gapSec >= 90) return '';
  return `（距你上一条仅 ${gapSec} 秒——同一个意思别换个说法再发；真有新东西再说）`;
}

/** Record a delivery without copying user-visible text into the event log. */
function persistBotDeliveryEvent(input: {
  chatId: number;
  messageId: number;
  taskId?: string;
  kind: string;
  replyToMessageId?: number;
  cognitiveAnchorEventId?: string;
}): string | undefined {
  try {
    const result = appendCognitiveEvent({
      type: 'bot_delivery',
      source: 'telegram',
      scope: input.taskId
        ? { visibility: 'task', taskId: input.taskId, chatId: input.chatId }
        : { visibility: 'chat', chatId: input.chatId },
      correlationId: input.taskId ? `task:${input.taskId}` : `telegram:${input.chatId}:delivery`,
      dedupeKey: `delivery:${input.taskId ?? input.chatId}:${input.messageId}`,
      ...(input.cognitiveAnchorEventId ? { causationId: input.cognitiveAnchorEventId } : {}),
      fact: {
        chatId: input.chatId,
        messageId: input.messageId,
        taskId: input.taskId ?? null,
        kind: input.kind,
        replyToMessageId: input.replyToMessageId ?? null,
      },
    });
    return result?.event.id;
  } catch {
    /* delivery telemetry never blocks a successful send */
    return undefined;
  }
}

// 2026-09-04 协议泄漏事故：goal 19 检查任务里模型把
//   早安主人～…
//   runtime.endTask("no_update")
//   endTask("no_update")
// 整段当纯文本发出（从未进 ```js 代码块）。出站前剥掉这类"把 API 调用当正文"的行：
// 其余部分是自然语言 → 只剥调用行照发；整段几乎都是调用语法 → 拒发/拒回。
// 模块级 export：executor 的 failsafe_plain_reply 路径也复用（那里不经过 host sendText）。
const API_CALL_LINE =
  /^(?:await\s+)?(?:runtime|telegram|memory|stickers|web|meta|computer|chats|goals|members|allowlist|admin|art|pixiv|linuxsb|self|console)\.\w+\s*\([\s\S]*?\)\s*;?$|^(?:await\s+)?endTask\s*\([\s\S]*?\)\s*;?$/;
export function stripApiCallLines(text: string): { clean: string; stripped: number } {
  if (!text.includes('(')) return { clean: text, stripped: 0 };
  const lines = text.split('\n');
  const kept: string[] = [];
  let stripped = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t && API_CALL_LINE.test(t)) {
      stripped += 1;
      continue;
    }
    kept.push(line);
  }
  return { clean: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), stripped };
}

// Tool-result placeholders: what host tools return when a call cannot be served
// (bad argument, disabled feature, empty result). They are scaffolding for the
// MODEL to read, never text to send — observed 2026-09-18: the bot passed
// "(invalid chatId)" straight into the master's DM after calling
// chats.recentMessages with a bad id and echoing the result.
//
// Kept as one list rather than a loose regex so a new placeholder is a
// deliberate addition, and the guard stays exact instead of over-matching
// legitimate messages that merely contain parentheses.
const TOOL_PLACEHOLDERS: readonly string[] = [
  '(invalid chatId)',
  '(invalid uid)',
  '(context unavailable)',
  '(memory unavailable)',
  '(digest persist disabled)',
  '(empty query)',
  '(empty topic)',
  '(empty)',
  '(no hits)',
  '(pixiv disabled)',
  '(web search disabled)',
  '(linux.sb disabled)',
  '(那个群最近没有记录)',
  '(没有找到相关记录)',
  '(检索失败)',
  '(读取失败)',
  '(谈资库读取失败)',
];

/** First tool-result placeholder found in `text`, or null. */
export function findToolPlaceholder(text: string): string | null {
  for (const ph of TOOL_PLACEHOLDERS) {
    if (text.includes(ph)) return ph;
  }
  // A bare parenthesised `invalid …` / `… unavailable` is the same class even if
  // a new tool invents one we have not listed yet.
  const generic = text.match(/\((?:invalid [^()]{1,40}|[^()]{1,40} unavailable|no [a-z ]{1,30} found)\)/i);
  return generic ? generic[0] : null;
}

import { createExecutionAudit, attachExecutionAudit, type AuditSnapshot } from '../agent/execution-audit.js';
import { markTaskVisible } from '../agent/task-progress.js';
import { emitTaskRuntimeEvent } from '../agent/task-runtime-events.js';
import { recordSelfReply } from '../tracking/self-history.js';
import type { AcceptanceContract, AcceptanceCheck, AcceptanceResult } from '../agent/task-evidence.js';
import * as sandboxPaths from '../sandbox/paths.js';

export type DeliveryKind = 'conversation' | 'progress' | 'discovery' | 'clarification' | 'partial_result' | 'final';

export interface HostApi {
  telegram: {
    sendText: (text: string, replyToMessageId?: number, kind?: DeliveryKind) => Promise<{ messageId: number }>;
    sendFinal: (text: string, replyToMessageId?: number) => Promise<{ messageId: number }>;
    sendSticker: (fileId: string) => Promise<{ messageId: number }>;
    /** Deliver a sandbox file to the user (sendDocument). Path is sandbox-relative. */
    sendFile: (path: string, caption?: string) => Promise<{ messageId: number }>;
    /** 把沙盒里的图片当**照片**发（内联显示，发图首选；文档/代码文件才用 sendFile）。 */
    sendPhoto: (path: string, caption?: string) => Promise<{ messageId: number }>;
    /** Synthesize + send a voice message (TTS). Falls back to {skipped} when TTS disabled. */
    sendVoice: (text: string) => Promise<{ messageId: number } | { skipped: true; reason: string }>;
    /**
     * 跨群送达（承诺闭环①）：把一条文字发到另一个群；可带沙盒相对路径文件
     * （券/图/报告当附件，text 变 caption）。仅主人 DM 任务可用，
     * 每任务限 2 次；目标必须是 bot 在的群。PROMISE_LOOP_ENABLED 门控。
     */
    sendToChat: (targetChatId: number, text: string, filePath?: string) => Promise<{ messageId: number }>;
    react: (messageId: number, emoji: string) => Promise<boolean>;
    /**
     * 发起群投票（匿名单选，Telegram 原生 poll）。仅群聊；每任务限 1 次、
     * 每群每天限 2 次（真人也不会一天到晚发起投票）。question ≤200 字，
     * options 2-10 个各 ≤60 字。返回 {messageId}（0=被闸/失败）。
     */
    sendPoll: (question: string, options: string[]) => Promise<{ messageId: number }>;
    /**
     * 转发消息（forwardMessage）。底线硬闸只有 DM 禁转（私聊内容不外流）；
     * 群对群转不转、转什么由模型自己按隐私准则判断（别转私人信息/别把人吐槽的话
     * 转到当事人群里/别转敏感内容）。targetChatId 省略=当前群。
     * 每任务限 2 次、目标群每天限 3 次。返回 {messageId}（0=被闸/失败）。
     */
    forward: (fromChatId: number, messageId: number, targetChatId?: number) => Promise<{ messageId: number }>;
  };
  /**
   * 群管理动作（真人感：bot 是群管理就该能干活）。调用前自动权限自检——
   * bot 在该群没有对应管理权限时报错并指路（让群主开权限）。仅群聊；
   * 每群每小时合计限 10 次。mute 不许对主人/bot 自己下手。
   */
  admin: {
    /** 删消息（默认当前群；不许跨群删）。 */
    deleteMessage: (messageId: number) => Promise<{ ok: boolean }>;
    /** 临时禁言（minutes 1-1440）。 */
    mute: (uid: number, minutes: number) => Promise<{ ok: boolean }>;
    /** 解除禁言。 */
    unmute: (uid: number) => Promise<{ ok: boolean }>;
    /** 置顶/取消置顶。pin 返回 pinnedPreview（实际被 pin 消息的前 80 字）——立刻核对，错了 unpin 重 pin。 */
    pin: (messageId: number) => Promise<{ ok: boolean; pinnedPreview: string }>;
    unpin: (messageId: number) => Promise<{ ok: boolean }>;
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
  /**
   * 画摊子（2026-08-23）：画图交给专职画摊子子代理——教学 prompt 喂 SVG 手艺，
   * 产出 SVG 光栅化成 PNG。
   * 默认**异步自动送达**（autoSend 省略=true）：立即返回 {started}，画好由系统直接把
   * 照片发到当前会话（带 caption）——LLM 出 SVG 实测 20-70s，任何固定单轮预算都可能
   * 输（2026-08-24 画树事故：轮超时杀死了已生成的图的送达），所以不让模型等结果；
   * 模型 sendText 一句「在画了」再 endTask 即可。autoSend=false = 同步拿
   * {pngPath,svgPath} 自己投递（跨群 sendToChat 附件等场景），会占满本轮预算。
   * 每任务限 2 次；失败自动发一条翻车说明。
   */
  art: {
    draw: (
      description: string,
      opts?: { width?: number; height?: number; caption?: string; autoSend?: boolean },
    ) => Promise<
      | { started: true; note: string }
      | { pngPath: string; svgPath: string; width: number; height: number }
      | { error: string }
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
    /** 本地 RSS 谈资库的最新条目（源/标题/链接）——找「我之前分享过的新闻出处」先翻这里。 */
    feed: () => Promise<string>;
  };
  /** Pixiv 公开全年龄搜图（只读；图片下载到沙盒路径，发送走 telegram.sendPhoto）。 */
  pixiv: {
    search: (query: string, limit?: number) => Promise<string>;
    download: (target: string) => Promise<{ path: string; id: string; bytes: number }>;
  };
  /** linux.sb 公开论坛只读浏览（最新/精华/板块列表、指定帖子、公开列表关键词匹配）。 */
  linuxsb: {
    latest: (sort?: string, limit?: number) => Promise<string>;
    topic: (target: string, limit?: number) => Promise<string>;
    search: (query: string, limit?: number) => Promise<string>;
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
    setAcceptance: (checks: AcceptanceCheck[]) => void;
    verifyAcceptance: () => Promise<AcceptanceResult>;
    /** Any user-visible delivery happened, including intermediate messages. */
    didSendText: () => boolean;
    /** A final delivery was explicitly sent or the task was ended. */
    didProduceFinal: () => boolean;
    /** An intermediate delivery happened without ending the task. */
    didSendIntermediate: () => boolean;
    /** The last delivery kind, if any. */
    lastDeliveryKind: () => DeliveryKind | undefined;
    /** Mark that the task is waiting for a user answer, not finished. */
    waitForUser: (reason?: string) => void;
    isWaitingForUser: () => boolean;
    waitingReason: () => string | undefined;
    /**
     * CSR Phase D：发送前自报对用户反应的预测（可选）。
     * 下一条成功 send* 会带上这条预测（source=model），用于后续 prediction error 学习。
     */
    predict: (text: string, predictedSentiment?: number) => void;
    /** 有产出（文字或文件都算）——长任务续跑判断用。 */
    didProduce: () => boolean;
    /** Await ctx/timing writes so Meta callback sees the reply. */
    flushBookkeeping: () => Promise<void>;
    /** 模型没 return 时兜底：取走本任务被忽略的查询类工具结果摘要（executor 用）。 */
    drainUnviewedResults?: () => string[];
    /** 工作记忆：记下「在等什么/答应了什么」，30 分钟自动过期。 */
    setScratch: (text: string) => Promise<void>;
    /**
     * 跨天的未了事：明确答应过、或明确在等的（"明天告诉你"）。
     * 与 setScratch 的区别：那是本次对话的工作记忆（30 分钟），这是能记到明天的。
     * 只记**明确承诺**——随口说的话不该变成明天的开场白。
     */
    rememberThread: (note: string, kind?: 'promised' | 'waiting') => Promise<void>;
    /** 事办完了清掉（prefix 匹配，省略 = 全清）。 */
    clearScratch: (prefix?: string) => Promise<void>;
    /**
     * auto+plan 模式（借鉴 code harness 的 plan mode）：多步任务开头列计划，
     * 之后每轮 prompt 里能看到自己的计划照它推进。任务内状态，不落库。
     */
    setPlan: (steps: string[]) => void;
    /** executor 每轮读；dirty=自上轮注入后有更新。 */
    getPlan: () => { steps: string[]; dirty: boolean } | null;
    markPlanRead: () => void;
  };
  /** Computer-use sandbox (terminal/browser/files). Throws sandbox_disabled when off. */
  computer: Record<string, (...args: never[]) => Promise<unknown>>;
  /** 自我改良：改自己的 prompt 文件（git 快照 + 动机说明 + 热重载）。 */
  self: {
    editPrompt: (relativePath: string, newContent: string, motive: string) => Promise<{ ok: boolean; reason?: string; backup?: string | null }>;
    readPrompt: (relativePath: string) => Promise<{ ok: boolean; content?: string; reason?: string }>;
    listPrompts: () => Promise<string[]>;
  };
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
    acceptance?: AcceptanceContract;
    priorAudit?: AuditSnapshot;
    defaultReplyTo?: number;
    /** 本任务全部可引用的 messageId（burst 分人回复要 quote 不同的 id）；显式 replyTo 必须落在此集合。 */
    quoteIds?: number[];
    /** Burst siblings - mark answered only after successful sendText. */
    relatedQuoteIds?: number[];
    isClosed?: () => boolean;
    taskId?: string;
    /** User target used for prediction calibration dimensions. */
    targetUserId?: number;
    /** Max sendText calls (default 2; work mode may pass 5). */
    maxTextSends?: number;
    /** Max sendFile calls (default unlimited; self-play passes 1). */
    maxFileSends?: number;
    /** Telegram forum topic (supergroup thread) id; routes replies into the correct topic. */
    messageThreadId?: number;
    /** Durable cognitive event that caused this task/runtime activity. */
    cognitiveAnchorEventId?: string;
  },
): HostApi {
  const sandboxRoot = (() => {
    try {
      const fn = (sandboxPaths as unknown as { resolveSandboxRoot?: () => string }).resolveSandboxRoot;
      if (typeof fn === 'function') return fn();
    } catch {
      void 0;
    }
    return '/tmp';
  })();
  const audit = createExecutionAudit(sandboxRoot, opts.acceptance, opts.priorAudit, {
    taskId: opts.taskId,
    chatId,
    cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
  });
  const banned = env().CODEACT_BANNED_WORDS;
  let ended = false;
  let textSent = 0;
  let finalSent = false;
  let intermediateSent = false;
  let lastDeliveryKind: DeliveryKind | undefined;
  let waitingForUser = false;
  let waitingReason = '';
  let pendingPrediction: { text: string; sentiment: number } | null = null;
  let fileSent = 0;
  let pollSent = false;
  let forwardsSent = 0;
  let artDraws = 0;
  // auto+plan：任务内计划（setPlan 写入，executor 每轮读 dirty 注入 prompt）
  let currentPlan: string[] | null = null;
  let planDirty = false;
  let lastSentNorm = '';
  let lastTextSentAt = 0;
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
      // Cognitive Debt：承诺同时是一笔未完成认知，goal 兑现/超时前始终可见。
      const { createDebt } = await import('../agent/cognitive-debts.js');
      createDebt({
        chatId,
        taskId: opts.taskId,
        kind: 'promise',
        statement: `对用户承诺了: ${topic}`,
        sourceEventIds: opts.taskId ? [`task:${opts.taskId}`] : [],
        priority: 8,
        confidence: 0.9,
        ttlSec: 3 * 24 * 3600,
        nextCheckInSec: 900,
      });
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
    // 本任务可引用的消息集合（burst 分人回复要 quote quotes 里不同的 id）
    const allowed = new Set(
      (opts.quoteIds ?? []).map((n) => Math.floor(Number(n))).filter((n) => n > 0),
    );
    if (fallback) allowed.add(fallback);

    // 显式传了不在本任务 quotes 里的 id → 串台风险（DM 曾把群 messageId 贴进来），拦。
    // 省略 = 不引用（2026-08-22 起群聊也不再自动补——真人不是每条回复都顶引用）。
    if (explicit !== undefined && allowed.size > 0 && !allowed.has(explicit)) {
      logger.warn(
        { chatId, fromModel: explicit, allowed: [...allowed], dm: isDM(chatId) },
        'host sendText: reject model replyTo ∉ task quotes',
      );
      throw new Error(
        `reply_to_mismatch: model used #${explicit}, not in this task's quotes (${[...allowed].join('/')}). ` +
          `Omit replyTo (no quote) or pass one of the task quotes, then retry sendText.`,
      );
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

  const api: HostApi = {
    telegram: {
      sendText(text: string, replyToMessageId?: number, kind: DeliveryKind = 'conversation') {
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
            const rawText = String(text ?? '').trim();
            if (!rawText) throw new Error('empty text');
            // 模型双转义事故（2026-08-24 做梦字条：整段话带着字面 \n 原样发给了主人）。
            // 模型在 JS 字符串里写了 \\n，eval 出来就是字面 backslash-n。签名：
            // 有字面 \n 序列且不含代码围栏（含围栏的可能是真代码片段，别动）。
            let clean = rawText;
            if (rawText.includes('\\n') && !rawText.includes('```')) {
              clean = rawText.replace(/\\n/g, '\n');
              logger.info({ chatId, chars: rawText.length }, 'host sendText: unescaped literal \\n from model');
            }
            // 协议泄漏兜底：剥掉把 API 调用当正文的行（如 runtime.endTask("no_update")）。
            {
              const s = stripApiCallLines(clean);
              if (s.stripped > 0) {
                if (!s.clean) {
                  logger.warn({ chatId, stripped: s.stripped }, 'host sendText rejected: entire payload was API-call syntax');
                  throw new Error('sendText_protocol_leak: text is only API-call syntax (e.g. runtime.endTask(...)); put calls in a ```js code block');
                }
                logger.warn({ chatId, stripped: s.stripped, kept: s.clean.length }, 'host sendText: stripped API-call lines from model text');
                clean = s.clean;
              }
            }
            if (clean.includes('[object Object]')) {
              throw new Error(
                'sendText_object_coercion: text contains "[object Object]" — sendFile/sendText return {messageId}; send the file, then describe it in a separate plain-text sendText without interpolating the return value',
              );
            }
            // Tool-result leakage: host tools return bracketed placeholders like
            // "(invalid chatId)" / "(那个群最近没有记录)" on failure. When a model
            // passes one straight through to sendText, the user receives internal
            // scaffolding as a message — observed 2026-09-18: the bot sent
            // "(invalid chatId)" verbatim into the master's DM because it had
            // called chats.recentMessages with a bad id and echoed the result.
            // Treat a payload that IS such a placeholder as a leak; strip it from
            // a longer sentence (the model may have wrapped it in real words).
            {
              const leak = findToolPlaceholder(clean);
              if (leak) {
                const withoutPlaceholder = clean.split(leak).join('').trim();
                if (!withoutPlaceholder) {
                  logger.warn({ chatId, leak }, 'host sendText rejected: payload was a tool-result placeholder');
                  throw new Error('sendText_tool_leak: the text is a tool result placeholder, not something to say; call the tool with a valid argument, or say something in your own words');
                }
                logger.warn({ chatId, leak, kept: withoutPlaceholder.length }, 'host sendText: stripped tool-result placeholder from model text');
                clean = withoutPlaceholder;
              }
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

            // 语义重复守卫：同义改写刷屏（「困到流口水了」→「困到打哈欠了」）字面相似度
            // 只有 0.13~0.27，上面的字面守卫结构上抓不到，只能问语义。只在第 2+ 次任务内
            // 发送时跑（首次发送零成本）；JeV 不可达一律 fail-open，绝不因检查失败吞消息。
            if (env().SEMANTIC_DUP_ENABLED && textSent > 0 && sentTexts.length > 0) {
              try {
                const { checkSemanticRepeat, semanticRepeatError } = await import('./semantic-dup.js');
                const dup = await checkSemanticRepeat(sentTexts, clean);
                if (dup.isRepeat) {
                  logger.info(
                    { chatId, preview: clean.slice(0, 60), probability: dup.probability, prior: dup.collidedWith?.slice(0, 60) },
                    'host sendText rejected semantic repeat',
                  );
                  throw new Error(semanticRepeatError(dup));
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.startsWith('重复表达未发送')) throw err;
                logger.debug({ err, chatId }, 'semantic-dup check failed — fail-open');
              }
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
              // Keep the full text and let the Telegram sender shard it. A silent
              // hard truncate here loses the tail of long task results.
              logger.info({ chatId, chars: clean.length, maxLen }, 'host sendText delegating long text to sender sharding');
            } else if (parts.length > 1) {
              logger.debug({ chatId, parts: parts.length, chars: clean.length }, 'host sendText preserving segmented text for sender sharding');
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
              await sendChatAction(chatId, 'typing', opts.messageThreadId);
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
              if (opts.taskId) markTaskVisible(opts.taskId);
              logger.info({ chatId, taskId: opts.taskId, deliveryKind: kind, messageId }, 'task delivery recorded');
              // Self-history: Meta is the production main path, so without this the
              // model would only ever see its legacy-pipeline acts (checkin/cards)
              // and never the conversation replies it actually sent — it could not
              // notice its own repetition. Records the real receipt, not intent.
              try {
                // opts has no trigger message/uid: the task's quoteIds are the
                // closest available provenance, and only the first bubble carries
                // the quote anchor. trigger_msg_id is informational; failure to
                // attribute it does not affect the behaviour feed.
                recordSelfReply(chatId, opts.targetUserId ?? 0, replyTo ?? null, part, messageId);
              } catch (err) {
                logger.debug({ err, chatId }, 'host sendText self-history failed (non-critical)');
              }
              // NyatOS participation budget: this is where the Meta path — the
              // production main path — actually sends, so this is where the
              // throttle must be spent. Wiring it only into
              // pipeline/stages/deliver.ts meant the budget never decreased on
              // real traffic (measured 2026-09-18: 96 "speak" shadow verdicts in
              // 23 minutes while Redis held zero budget keys, so every Frame
              // still advertised a full "6/6 remaining").
              if (env().NYATOS_BUDGET_ENABLED) {
                void import('../nyatos/budget.js')
                  .then(({ spendParticipation, markActiveSpeech }) => {
                    spendParticipation(chatId);
                    markActiveSpeech(chatId);
                  })
                  .catch((err) => logger.debug({ err, chatId }, 'budget spend failed (non-critical)'));
              }
              // Task deliveries are already persisted by task-runtime-events;
              // normal legacy replies need the same durable delivery fact.
              const deliveryEventId = !opts.taskId
                ? persistBotDeliveryEvent({
                    chatId,
                    messageId,
                    kind,
                    replyToMessageId: replyTo,
                    cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
                  })
                : undefined;
              if (opts.taskId) {
                emitTaskRuntimeEvent({
                  kind: 'model_message_sent',
                  taskId: opts.taskId,
                  chatId,
                  cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
                  messageId,
                  deliveryKind: kind,
                });
              }
              // Phase D：登记交付预测。模型 predict() 过 → source=model；否则系统先验。
              try {
                const pending = pendingPrediction;
                pendingPrediction = null;
                if (pending) {
                  recordPrediction({
                    chatId, taskId: opts.taskId, messageId,
                    source: 'model', prediction: pending.text, predictedSentiment: pending.sentiment,
                    userId: opts.targetUserId, actionType: 'speak',
                    sourceEventId: deliveryEventId,
                  });
                } else {
                  recordPrediction({
                    chatId,
                    taskId: opts.taskId,
                    messageId,
                    userId: opts.targetUserId,
                    actionType: 'speak',
                    sourceEventId: deliveryEventId,
                  });
                }
              } catch {
                /* telemetry never breaks delivery */
              }
              // Group delivery also creates a bounded social expectation. The
              // interaction graph/reaction bridge settles it from host facts;
              // no reply strategy is changed by this telemetry.
              if (env().SOCIAL_PREDICTION_ENABLED === true) {
                try {
                  recordSocialDeliveryPrediction({
                    chatId,
                    botMessageId: messageId,
                    ...(opts.targetUserId === undefined ? {} : { targetUserId: opts.targetUserId }),
                    ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
                    actionType: kind,
                    ...(deliveryEventId ? { sourceEventId: deliveryEventId } : {}),
                  });
                } catch {
                  /* social telemetry never breaks delivery */
                }
              }
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
            lastDeliveryKind = kind;
            if (kind === 'final') finalSent = true;
            else intermediateSent = true;

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

            const gapSec = lastTextSentAt > 0 ? Math.round((Date.now() - lastTextSentAt) / 1000) : null;
            lastTextSentAt = Date.now();
            const pacingSuffix =
              env().SEND_PACING_FACT_ENABLED && gapSec !== null ? buildPacingAckSuffix(gapSec) : '';
            return makeSendAck(`text_sent#${lastMessageId}${pacingSuffix}`, lastMessageId);
          })(),
        );
      },
      sendFinal(text: string, replyToMessageId?: number) {
        return this.sendText(text, replyToMessageId, 'final');
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
            await sendChatAction(chatId, 'typing', opts.messageThreadId);
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
              await sendChatAction(chatId, 'upload_photo', opts.messageThreadId);
              const { messageId } = await tgSendFile(chatId, target, {
                // A caption is user-visible text; strip tool scaffolding like any
                // other send path.
                caption: caption
                  ? (() => {
                      let c = String(caption).slice(0, 1000);
                      const leak = findToolPlaceholder(c);
                      if (leak) {
                        c = c.split(leak).join('').trim();
                        logger.warn({ chatId, leak }, 'sendFile: stripped tool-result placeholder from caption');
                      }
                      return c || undefined;
                    })()
                  : undefined,
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
      sendPhoto(path: string, caption?: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            // 与 sendFile 共用 maxFileSends 闸（都是「发一个沙盒文件出去」）。
            if (fileSent >= maxFileSends) {
              throw new Error(`sendFile_limit:${maxFileSends}`);
            }
            const raw = String(path ?? '').trim();
            if (!raw) {
              logger.warn({ chatId }, 'host sendPhoto rejected empty path');
              return makeSendAck('photo_send_failed:empty_path', 0);
            }
            try {
              const { resolveInsideSandbox } = await import('../sandbox/paths.js');
              const { basename } = await import('node:path');
              const target = resolveInsideSandbox(raw); // throws on path escape
              const { sendPhoto: tgSendPhoto } = await import('../bot/sender/telegram.js');
              await sendChatAction(chatId, 'upload_photo', opts.messageThreadId);
              const { messageId } = await tgSendPhoto(chatId, target, {
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
                        { textContent: `[photo] ${basename(target)}${caption ? `: ${String(caption).slice(0, 80)}` : ''}`, messageId },
                        opts.messageThreadId,
                      ),
                    )
                    .catch((err) => logger.debug({ err, chatId }, 'host addAssistant photo failed')),
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
              return makeSendAck(messageId > 0 ? `photo_sent:${basename(target)}#${messageId}` : 'photo_send_failed', messageId);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn({ err, chatId, path: raw }, 'host sendPhoto failed (non-fatal)');
              return makeSendAck(`photo_send_failed:${msg}`, 0);
            }
          })(),
        );
      },
      sendVoice(text: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            let clean = String(text ?? '').trim();
            if (!clean) return { skipped: true as const, reason: 'empty_text' };
            // Speaking a tool placeholder aloud is the same leak as typing it.
            {
              const leak = findToolPlaceholder(clean);
              if (leak) {
                clean = clean.split(leak).join('').trim();
                if (!clean) return { skipped: true as const, reason: 'tool_leak' };
                logger.warn({ chatId, leak }, 'sendVoice: stripped tool-result placeholder');
              }
            }
            try {
              const { synthesizeVoice } = await import('../ai/tts.js');
              const { sendVoice: tgSendVoice } = await import('../bot/sender/telegram.js');
              const ogg = await synthesizeVoice(clean.slice(0, 500));
              if (!ogg) return { skipped: true as const, reason: 'tts_disabled' };
              await sendChatAction(chatId, 'record_voice', opts.messageThreadId);
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
      sendPoll(question: string, options: string[]) {
        assertOpen();
        return trackInflight(
          (async () => {
            // 真人感：投票是「事件型」动作——仅群聊、每任务 1 次、每群每天 2 次。
            if (chatId > 0) throw new Error('sendPoll_groups_only: 投票只在群里发起');
            if (pollSent) throw new Error('sendPoll_limit:1_per_task');
            const q = String(question ?? '').trim().slice(0, 200);
            const pollOpts = (Array.isArray(options) ? options : [])
              .map((o) => String(o ?? '').trim().slice(0, 60))
              .filter(Boolean)
              .slice(0, 10);
            if (!q) throw new Error('sendPoll_empty_question');
            if (pollOpts.length < 2) throw new Error('sendPoll_need_2_options');
            assertNotBanned(q + ' ' + pollOpts.join(' '));
            // 每群每天 cap 2（react 的 dayKey 同款；原子 incr 防并发双发）
            const { getRedis } = await import('../db/redis.js');
            const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const key = `xxb:poll:${chatId}:${day}`;
            const n = await getRedis().incr(key);
            if (n === 1) await getRedis().expire(key, 30 * 3600);
            if (n > 2) {
              logger.info({ chatId }, 'host sendPoll rejected daily cap');
              return { messageId: 0 };
            }
            const { sendPoll } = await import('../bot/sender/telegram.js');
            const messageId = await sendPoll(chatId, q, pollOpts, opts.messageThreadId);
            if (messageId > 0) {
              pollSent = true;
              try {
                const { addAssistant } = await import('../pipeline/context/manager.js');
                await addAssistant(chatId, {
                  textContent: `[投票] ${q}（${pollOpts.join(' / ')}）`,
                  messageId,
                }, opts.messageThreadId);
              } catch { /* non-critical */ }
              logger.info({ chatId, q: q.slice(0, 40), options: pollOpts.length }, 'host sendPoll sent');
            }
            return { messageId };
          })(),
        );
      },
      forward(fromChatId: number, messageId: number, targetChatId?: number) {
        assertOpen();
        return trackInflight(
          (async () => {
            const tid = Number(targetChatId ?? chatId);
            const fid = Number(fromChatId);
            const mid = Math.floor(Number(messageId));
            if (!Number.isFinite(fid) || !Number.isFinite(tid) || !Number.isFinite(mid) || mid <= 0) {
              throw new Error('forward_invalid_args');
            }
            // 隐私闸只钉死一条底线：DM 一律禁（私聊内容不外流）。群对群转不转、
            // 转什么由模型自己按隐私准则判断（2026-08-22 用户拍板：本质是 AI 决策）。
            if (fid > 0 || tid > 0) {
              throw new Error('forward_groups_only: 只允许群对群转发，私聊内容不外流');
            }
            if (forwardsSent >= 2) throw new Error('forward_limit:2_per_task');
            // 目标群每天 cap 3（防刷，不是语义判断）
            const { getRedis } = await import('../db/redis.js');
            const redis = getRedis();
            const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const key = `xxb:forward:${tid}:${day}`;
            const n = await redis.incr(key);
            if (n === 1) await redis.expire(key, 30 * 3600);
            if (n > 3) {
              logger.info({ chatId: tid }, 'host forward rejected daily cap');
              return { messageId: 0 };
            }
            const { forwardMessage } = await import('../bot/sender/telegram.js');
            const outMessageId = await forwardMessage(tid, fid, mid);
            if (outMessageId > 0) {
              forwardsSent++;
              try {
                const { addAssistant } = await import('../pipeline/context/manager.js');
                await addAssistant(tid, {
                  textContent: `[转发] 从另一个群转来的消息`,
                  messageId: outMessageId,
                });
              } catch { /* non-critical */ }
              logger.info({ from: fid, to: tid, messageId: mid, outMessageId }, 'host forward delivered');
            }
            return { messageId: outMessageId };
          })(),
        );
      },
      sendToChat(targetChatId: number, text: string, filePath?: string) {
        assertOpen();
        return trackInflight(
          (async () => {
            if (!env().PROMISE_LOOP_ENABLED) throw new Error('promise_loop_disabled');
            // v1 安全闸：只有主人 DM 里的任务可以跨群送达（主人指派的递送场景）。
            if (!env().MASTER_UID || chatId !== env().MASTER_UID) throw new Error('sendToChat_master_dm_only');
            const tid = Number(targetChatId);
            if (!Number.isFinite(tid) || tid === 0) {
              throw new Error('sendToChat_invalid_target: group chatId (negative) or user uid (positive) required');
            }
            if (crossSends >= 2) throw new Error('sendToChat_limit:2');
            let clean = String(text ?? '').trim();
            if (!clean) throw new Error('empty text');
            // Same tool-result leak guard as host sendText: sending to another
            // chat must not be a back door for scaffolding.
            {
              const leak = findToolPlaceholder(clean);
              if (leak) {
                const withoutPlaceholder = clean.split(leak).join('').trim();
                if (!withoutPlaceholder) {
                  throw new Error('sendText_tool_leak: the text is a tool result placeholder, not something to say; call the tool with a valid argument, or say something in your own words');
                }
                logger.warn({ chatId: tid, leak }, 'telegram.sendMessage: stripped tool-result placeholder');
                clean = withoutPlaceholder;
              }
            }
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
              await sendChatAction(tid, 'upload_document', opts.messageThreadId);
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
            persistBotDeliveryEvent({
              chatId: tid,
              messageId,
              taskId: opts.taskId,
              kind: 'cross_chat',
              cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
            });
            return makeSendAck(`cross_sent#${messageId}`, messageId);
          })(),
        );
      },
    },
    admin: (() => {
      /** 权限自检：bot 在该群没有对应管理权限时 throw 指路（admin 权限不一定给到）。 */
      const assertAdminPerm = async (
        perm: 'can_delete_messages' | 'can_restrict_members' | 'can_pin_messages',
      ): Promise<void> => {
        const { getBot, getBotUid } = await import('../bot/bot.js');
        const member = (await getBot().api.getChatMember(chatId, getBotUid())) as unknown as Record<string, unknown>;
        const status = String(member['status'] ?? '');
        if (status !== 'administrator' || member[perm] !== true) {
          const permName = perm.replace(/^can_/i, '').replace(/_/g, ' ');
          throw new Error(
            `admin_no_permission: 我在这个群没有管理权限（需要 ${permName}）——让群主/管理在群设置里给我开一下再喊我`,
          );
        }
      };
      const rateGate = async (): Promise<void> => {
        const { getRedis } = await import('../db/redis.js');
        const hourKey = Math.floor(Date.now() / 3600_000);
        const key = `xxb:admin_act:${chatId}:${hourKey}`;
        const n = await getRedis().incr(key);
        if (n === 1) await getRedis().expire(key, 7200);
        if (n > 10) throw new Error('admin_rate_limit: 本群每小时管理动作上限 10 次');
      };
      const assertGroup = (): void => {
        if (chatId > 0) throw new Error('admin_groups_only: 管理动作只在群里');
      };
      return {
        async deleteMessage(messageId: number) {
          assertOpen();
          assertGroup();
          const mid = Math.floor(Number(messageId));
          if (!Number.isFinite(mid) || mid <= 0) throw new Error('invalid messageId');
          await assertAdminPerm('can_delete_messages');
          await rateGate();
          const { deleteMessage } = await import('../bot/sender/telegram.js');
          await deleteMessage(chatId, mid); // 现有 sender 静默失败版；权限自检已在前面真验证
          logger.info({ chatId, messageId: mid }, 'host admin.deleteMessage');
          return { ok: true };
        },
        async mute(uid: number, minutes: number) {
          assertOpen();
          assertGroup();
          const target = Math.floor(Number(uid));
          const mins = Math.min(Math.max(Math.floor(Number(minutes)) || 10, 1), 1440);
          if (!Number.isFinite(target) || target <= 0) throw new Error('invalid uid');
          if (target === env().MASTER_UID) throw new Error('admin_no_master: 不许对主人下手');
          const { getBotUid } = await import('../bot/bot.js');
          if (target === getBotUid()) throw new Error('admin_no_self: 不能禁言我自己');
          await assertAdminPerm('can_restrict_members');
          await rateGate();
          const { muteMember } = await import('../bot/sender/telegram.js');
          const ok = await muteMember(chatId, target, mins);
          logger.info({ chatId, uid: target, minutes: mins, ok }, 'host admin.mute');
          return { ok };
        },
        async unmute(uid: number) {
          assertOpen();
          assertGroup();
          const target = Math.floor(Number(uid));
          if (!Number.isFinite(target) || target <= 0) throw new Error('invalid uid');
          await assertAdminPerm('can_restrict_members');
          await rateGate();
          const { unmuteMember } = await import('../bot/sender/telegram.js');
          const ok = await unmuteMember(chatId, target);
          logger.info({ chatId, uid: target, ok }, 'host admin.unmute');
          return { ok };
        },
        async pin(messageId: number) {
          assertOpen();
          assertGroup();
          const mid = Math.floor(Number(messageId));
          if (!Number.isFinite(mid) || mid <= 0) throw new Error('invalid messageId');
          await assertAdminPerm('can_pin_messages');
          await rateGate();
          const { pinMessage } = await import('../bot/sender/telegram.js');
          const ok = await pinMessage(chatId, mid, false);
          // pin 完把「实际 pin 的消息内容」带回去——模型立刻看到 pin 的是什么，
          // 错了能自己 unpin 重 pin（2026-08-22：pin 错消息的事故预防）。
          let preview = '';
          try {
            const { getRecent } = await import('../pipeline/context/manager.js');
            const msgs = await getRecent(chatId, 60);
            const hit = msgs.find((m) => m.messageId === mid);
            preview = (hit?.textContent ?? '').slice(0, 80);
          } catch { /* best-effort */ }
          logger.info({ chatId, messageId: mid, ok, preview: preview.slice(0, 40) }, 'host admin.pin');
          return { ok, pinnedPreview: preview || '(内容未取到——用 chats.recentMessages 自己核对)' };
        },
        async unpin(messageId: number) {
          assertOpen();
          assertGroup();
          const mid = Math.floor(Number(messageId));
          if (!Number.isFinite(mid) || mid <= 0) throw new Error('invalid messageId');
          await assertAdminPerm('can_pin_messages');
          await rateGate();
          const { pinMessage } = await import('../bot/sender/telegram.js');
          const ok = await pinMessage(chatId, mid, true);
          logger.info({ chatId, messageId: mid, ok }, 'host admin.unpin');
          return { ok };
        },
      };
    })(),
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
    art: {
      draw(description: string, drawOpts?: { width?: number; height?: number; caption?: string; autoSend?: boolean }) {
        assertOpen();
        const autoSend = drawOpts?.autoSend !== false;
        if (!autoSend) {
          // 同步路径：调用方自己拿路径去投递（跨群 sendToChat 附件等）。慢，会占满本轮预算。
          return trackInflight(
            (async () => {
              if (artDraws >= 2) return { error: 'art_limit:2_per_task' };
              artDraws++;
              try {
                const { drawArtwork } = await import('../agent/artist.js');
                const r = await drawArtwork(String(description ?? ''), drawOpts ?? {});
                if ('error' in r) {
                  logger.warn({ chatId, err: r.error }, 'host art.draw failed');
                  return r;
                }
                logger.info({ chatId, png: r.pngPath, w: r.width, h: r.height }, 'host art.draw done (sync)');
                return r;
              } catch (err) {
                return { error: `art_failed:${err instanceof Error ? err.message : String(err)}` };
              }
            })(),
          );
        }
        // 异步自动送达（默认）：画+发不绑单轮超时预算——轮死了画照样能送达
        // （inflight 任务会被 close 前的 flushBookkeeping 等到，typing 心跳覆盖全程）。
        if (artDraws >= 2) return Promise.resolve({ error: 'art_limit:2_per_task' });
        artDraws++;
        const caption = String(drawOpts?.caption ?? '').slice(0, 200);
        const job = (async () => {
          // 「正在发送照片」标识续命到送达（任务级 typing 心跳在 close 后就停了，
          // 而本 job 可能比任务活得久）。
          const keepalive = setInterval(() => {
            void sendChatAction(chatId, 'upload_photo', opts.messageThreadId);
          }, 4000);
          try {
            void sendChatAction(chatId, 'upload_photo', opts.messageThreadId);
            const { drawArtwork } = await import('../agent/artist.js');
            const r = await drawArtwork(String(description ?? ''), {
              width: drawOpts?.width,
              height: drawOpts?.height,
            });
            if ('error' in r) {
              logger.warn({ chatId, err: r.error }, 'host art.draw(async) failed');
              // 办不到要老实收场（翻车说明也走完整发送链，让上下文知道 bot 说过）。
              const { sendMessage: tgSendMessage } = await import('../bot/sender/telegram.js');
              await tgSendMessage(
                chatId,
                '呜……画摊子翻车了，这张图没画成。换个说法再让我试一次？',
                opts.defaultReplyTo,
                opts.messageThreadId,
              ).catch(() => 0);
              return;
            }
            const { resolveInsideSandbox } = await import('../sandbox/paths.js');
            const { sendPhoto: tgSendPhoto } = await import('../bot/sender/telegram.js');
            const target = resolveInsideSandbox(r.pngPath);
            const { messageId } = await tgSendPhoto(chatId, target, {
              caption: caption || undefined,
              replyToId: opts.defaultReplyTo,
              messageThreadId: opts.messageThreadId,
            });
            if (messageId > 0) {
              fileSent++;
              try {
                const { addAssistant } = await import('../pipeline/context/manager.js');
                await addAssistant(
                  chatId,
                  { textContent: `[photo] ${r.pngPath}${caption ? `: ${caption.slice(0, 80)}` : ''}`, messageId },
                  opts.messageThreadId,
                );
              } catch { /* non-critical */ }
              const answeredIds = new Set<number>();
              if (opts.defaultReplyTo && opts.defaultReplyTo > 0) answeredIds.add(opts.defaultReplyTo);
              for (const mid of opts.relatedQuoteIds ?? []) {
                if (mid > 0) answeredIds.add(mid);
              }
              await Promise.all(
                [...answeredIds].map((mid) => markMessageAnswered(chatId, mid).catch(() => undefined)),
              );
            }
            logger.info({ chatId, png: r.pngPath, messageId }, 'host art.draw(async) delivered');
          } catch (err) {
            logger.warn({ err, chatId }, 'host art.draw(async) job failed');
          } finally {
            clearInterval(keepalive);
          }
        })();
        trackInflight(job);
        return Promise.resolve({
          started: true as const,
          note: '画摊子开工了——画好会自动把照片发到这个会话（带你的 caption）。你先 sendText 一句「在画了」之类的话，别干等结果，也别重复调用。',
        });
      },
    },
    goals: {
      async add(topic: string, targetChatId?: number, checkInMinutes?: number) {
        assertOpen();
        if (!env().PROMISE_LOOP_ENABLED) return { goalId: null, reason: 'promise_loop_disabled' };
        const t = String(topic ?? '').trim().slice(0, 100);
        if (!t) return { goalId: null, reason: 'empty_topic' };
        const cid = Number(targetChatId);
        // 2026-08-22 审查修复: 目标群必须与任务同源(防跨群挂 goal), 主人 DM 任务可指定任意已开群。
        const isMasterTask = env().MASTER_UID > 0 && chatId === env().MASTER_UID;
        if (Number.isFinite(cid) && cid !== 0 && cid !== chatId && !isMasterTask) {
          return { goalId: null, reason: 'goal_target_chat_mismatch' };
        }
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
      async feed() {
        assertOpen();
        // 本地 RSS 谈资库（xxb:rss:fuel:* 全群聚合）：bot 分享过的新闻的出处就在这。
        try {
          const { getRedis } = await import('../db/redis.js');
          const redis = getRedis();
          const keys = await redis.keys('xxb:rss:fuel:*');
          const items: string[] = [];
          for (const k of keys.slice(0, 5)) {
            const raws = await redis.lrange(k, 0, 9);
            for (const raw of raws) {
              try {
                const it = JSON.parse(raw) as { title?: string; link?: string; source?: string };
                if (it.title) {
                  items.push(`[${it.source ?? '?'}] ${it.title}${it.link ? ` ${it.link}` : ''}`.slice(0, 200));
                }
              } catch { /* skip malformed */ }
            }
          }
          const out = items.slice(0, 12).join('\n');
          const text = out || '(谈资库是空的)';
          noteUnviewed('web.feed', text);
          return text;
        } catch (err) {
          logger.debug({ err, chatId }, 'host web.feed failed');
          return '(谈资库读取失败)';
        }
      },
    },
    pixiv: {
      async search(query: string, limit?: number) {
        assertOpen();
        if (!env().CODEACT_PIXIV_ENABLED) return '(pixiv disabled)';
        const q = String(query ?? '').trim().slice(0, 100);
        if (!q) return '(empty query)';
        try {
          const { searchPixiv } = await import('../pipeline/tools/pixiv.js');
          const rows = await searchPixiv(q, { limit });
          const out = rows.length
            ? rows
                .map(
                  (w, i) =>
                    `${i + 1}. ${w.title} — ${w.userName || 'unknown'}\n` +
                    `   ${w.pageUrl}\n` +
                    `   tags: ${w.tags.slice(0, 8).join(', ') || '(none)'}\n` +
                    `   thumb: ${w.thumbUrl}`,
                )
                .join('\n')
            : '(no public all-ages results)';
          noteUnviewed(`pixiv.search(${q.slice(0, 40)})`, out);
          return out;
        } catch (err) {
          logger.warn({ err, chatId, q: q.slice(0, 80) }, 'host pixiv.search failed');
          return `Pixiv 搜索失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      async download(target: string) {
        assertOpen();
        if (!env().CODEACT_PIXIV_ENABLED) throw new Error('pixiv_disabled');
        const raw = String(target ?? '').trim().slice(0, 500);
        if (!raw) throw new Error('pixiv_empty_target');
        try {
          const { downloadPixivImage } = await import('../pipeline/tools/pixiv.js');
          const out = await downloadPixivImage(raw);
          logger.info({ chatId, id: out.id, bytes: out.bytes }, 'host pixiv.download');
          noteUnviewed(`pixiv.download(${raw.slice(0, 60)})`, out);
          return out;
        } catch (err) {
          logger.warn({ err, chatId, target: raw.slice(0, 120) }, 'host pixiv.download failed');
          throw err;
        }
      },
    },
    linuxsb: {
      async latest(sort?: string, limit?: number) {
        assertOpen();
        if (!env().CODEACT_LINUXSB_ENABLED) return '(linux.sb disabled)';
        try {
          const { fetchLinuxSbLatest } = await import('../pipeline/tools/linuxsb.js');
          const rows = await fetchLinuxSbLatest({ sort, limit });
          const out = rows.length
            ? rows
                .map(
                  (r, i) =>
                    `${i + 1}. ${r.pinned ? '[置顶] ' : ''}${r.title}\n` +
                    `   ${r.url}\n` +
                    `   ${r.author || '?'} · ${r.forum || '?'} · ${r.time || '?'}`,
                )
                .join('\n')
            : '(no topics)';
          noteUnviewed(`linuxsb.latest(${String(sort ?? 'comment').slice(0, 20)})`, out);
          return out;
        } catch (err) {
          logger.warn({ err, chatId, sort }, 'host linuxsb.latest failed');
          return `linux.sb 最新列表获取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      async topic(target: string, limit?: number) {
        assertOpen();
        if (!env().CODEACT_LINUXSB_ENABLED) return '(linux.sb disabled)';
        const raw = String(target ?? '').trim().slice(0, 500);
        if (!raw) return '(empty topic)';
        try {
          const { fetchLinuxSbTopic } = await import('../pipeline/tools/linuxsb.js');
          const t = await fetchLinuxSbTopic(raw, { limit });
          const body = t.posts
            .map((p) => `#${p.id} ${p.author || '?'} ${p.time ? `(${p.time})` : ''}\n${p.text}`)
            .join('\n\n');
          const out = `${t.title}\n${t.url}\n板块: ${t.forum || '?'}\n\n${body || '(no posts parsed)'}`;
          noteUnviewed(`linuxsb.topic(${raw.slice(0, 40)})`, out);
          return out.slice(0, 5000);
        } catch (err) {
          logger.warn({ err, chatId, target: raw.slice(0, 120) }, 'host linuxsb.topic failed');
          return `linux.sb 帖子获取失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      async search(query: string, limit?: number) {
        assertOpen();
        if (!env().CODEACT_LINUXSB_ENABLED) return '(linux.sb disabled)';
        const q = String(query ?? '').trim().slice(0, 100);
        if (!q) return '(empty query)';
        try {
          const { searchLinuxSb } = await import('../pipeline/tools/linuxsb.js');
          const rows = await searchLinuxSb(q, { limit });
          const out = rows.length
            ? rows.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.author || '?'} · ${r.forum || '?'} · ${r.time || '?'}`).join('\n')
            : '(公开列表里没匹配到；站内搜索需要登录，第一版没接 cookie)';
          noteUnviewed(`linuxsb.search(${q.slice(0, 40)})`, out);
          return out;
        } catch (err) {
          logger.warn({ err, chatId, q: q.slice(0, 80) }, 'host linuxsb.search failed');
          return `linux.sb 搜索失败: ${err instanceof Error ? err.message : String(err)}`;
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
      setAcceptance(checks) { audit.propose(checks); },
      verifyAcceptance() { return audit.verify(); },
      endTask(summary: string) {
        logger.info({ chatId, taskId: opts.taskId, summary: String(summary ?? '').slice(0, 160), deliveryKind: lastDeliveryKind ?? null }, 'task finalization requested');
        if (ended) return;
        if (!String(summary).startsWith('failed')) audit.assertCanEnd();
        ended = true;
        // 承诺闭环③ 兜底：说了「等下/我去…」但没立 goal 也没跨群送达 → 自动补 goal。
        void promiseBackstop();
        opts.onEnd(String(summary ?? '').slice(0, 1000));
      },
      didSendText() {
        return textSent > 0;
      },
      didProduceFinal() {
        return finalSent || ended;
      },
      didSendIntermediate() {
        return intermediateSent;
      },
      lastDeliveryKind() {
        return lastDeliveryKind;
      },
      waitForUser(reason?: string) {
        waitingForUser = true;
        waitingReason = String(reason ?? '').slice(0, 240);
        lastDeliveryKind = 'clarification';
        if (opts.taskId) {
          emitTaskRuntimeEvent({
            kind: 'task_waiting_user',
            taskId: opts.taskId,
            chatId,
            cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
          });
        }
      },
      isWaitingForUser() {
        return waitingForUser;
      },
      waitingReason() {
        return waitingReason || undefined;
      },
      predict(text: string, predictedSentiment?: number) {
        const t = String(text ?? '').trim().slice(0, 400);
        if (!t) return;
        const s = predictedSentiment ?? 0.5;
        pendingPrediction = { text: t, sentiment: Math.min(1, Math.max(0, s)) };
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
      async rememberThread(note: string, kind?: 'promised' | 'waiting') {
        try {
          const { rememberThread } = await import('../tracking/open-threads.js');
          rememberThread({
            chatId,
            uid: opts.targetUserId ?? 0,
            note,
            kind: kind === 'waiting' ? 'waiting' : 'promised',
          });
        } catch (err) {
          logger.debug({ err, chatId }, 'host rememberThread failed');
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
      setPlan(steps: string[]) {
        const clean = (Array.isArray(steps) ? steps : [])
          .map((s) => String(s ?? '').trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 8);
        if (!clean.length) return;
        currentPlan = clean;
        planDirty = true;
        logger.info({ chatId, steps: clean.length }, 'host runtime.setPlan');
      },
      getPlan() {
        return currentPlan ? { steps: currentPlan, dirty: planDirty } : null;
      },
      markPlanRead() {
        planDirty = false;
      },
    },
    computer: buildComputerApi(noteUnviewed),
    self: {
      async editPrompt(relativePath: string, newContent: string, motive: string) {
        const { selfEditPrompt } = await import('../agent/self-improve.js');
        const gated = (() => {
          try {
            return env().SELF_EDIT_GUARDRAILS_ENABLED === true;
          } catch {
            return false;
          }
        })();
        const r = selfEditPrompt(String(relativePath), String(newContent), String(motive ?? ''), {
          skipCooldownForTest: !gated,
        });
        // Self-edits never self-certify: annotate the stored motive with the task
        // assessment (unverified unless host evidence proves otherwise).
        // P3-2: explicit rowid from selfEditPrompt — never last_insert_rowid(),
        // which could hit an unrelated row if the motive INSERT failed.
        if (r.ok && r.motiveRowid != null) {
          try {
            const { getDb } = await import('../db/sqlite.js');
            getDb().prepare(`UPDATE self_model_notes SET note = note || ? WHERE rowid = ?`)
              .run(` [task assessment at edit: ${audit.snapshot().totalCalls} calls observed]`, r.motiveRowid);
          } catch { /* motive annotation is best-effort */ }
        }
        return r;
      },
      async readPrompt(relativePath: string) {
        const { selfReadPrompt } = await import('../agent/self-improve.js');
        return selfReadPrompt(String(relativePath));
      },
      async listPrompts() {
        const { selfListPrompts } = await import('../agent/self-improve.js');
        return selfListPrompts();
      },
    },
  };
  // Runtime stays synchronous. All tool receipts originate from host-returned results.
  for (const key of Object.keys(api) as (keyof HostApi)[]) {
    if (key === 'runtime') continue;
    const namespaces = api as unknown as Record<string, object>;
    namespaces[key] = audit.wrap(key, namespaces[key]!);
  }
  attachExecutionAudit(api, audit);
  return api;
}
