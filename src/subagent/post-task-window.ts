/**
 * post-task-window.ts — CodeAct 发言后的短时发酵窗口（CGM 借鉴）
 *
 * Subagent 在某群发完消息后开一个 ~POST_TASK_WINDOW_MS 的窗口：窗口内该群的
 * 人类新消息被额外缓冲进来（不影响正常 Meta 路径），每 ~5s 由一个极便宜的 LLM
 * 判定「有没有人接住/追问了 bot 刚说的话」。命中则绕过 Meta 直接补一轮 CodeAct
 * 续答，并把这批消息标成 answered，防止 Meta 路径双回。
 *
 * 全部 fail-soft：judge 失败跳过该批，dispatch 失败只记日志；开关关掉时一切 no-op。
 * 单进程内存态即可（窗口本来就短，重启丢失可接受）。
 */

import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isGroup } from '../shared/chat.js';
import { loadCachedPrompt } from '../shared/config.js';
import { sanitizeContentDirection } from '../shared/message-text.js';
import { markMessageAnswered } from '../meta/answered.js';
import { callWithFallback } from '../ai/fallback.js';
import { enqueueCodeActJob } from './queue.js';
import type { DispatchTask } from '../meta/types.js';

/** follow-up 判定节拍（ms）。 */
const TICK_MS = 5_000;
/** judge 在飞时快速重排。 */
const IDLE_RECHECK_MS = 2_000;
/** 每窗口最多补几轮（防来回刷）。 */
const MAX_CONTINUATIONS_PER_WINDOW = 2;
/** 窗口缓冲上限，防洪水群撑爆内存。 */
const MAX_BUFFERED_MESSAGES = 50;
/** 窗口硬寿命 = max(3 × windowMs, 5min)：bot 连续发言会一直顺延窗口，得有个顶。 */
const MIN_HARD_LIFETIME_MS = 5 * 60_000;

const DEFAULT_FOLLOWUP_PROMPT = [
  '你是一个极轻量的 post-task follow-up 判定器。',
  '群聊 bot 刚主动发了言，之后几秒内群友发了一批新消息。判断有没有人在没有 @ / 没有引用的情况下接住、追问、质疑或补充了 bot 刚说的话。',
  'true：有人追问/质疑/纠正/补充 bot 刚说的话，或明显在回应 bot 刚发的内容。',
  'false：纯「哈哈/收到/+1」附和、转向无关新话题、已被别人自然接住解决、拿不准。',
  '只输出严格 JSON：{"hasFollowUp": true, "triggerMessageId": 123456, "reason": "一句话"}',
].join('\n');

export interface BotSpokeInfo {
  /** bot 刚发出的最后一条 Telegram messageId（可选，贴纸可能为 0）。 */
  messageId?: number;
  /** bot 发言文本预览（窗口锚点，judge 依据）。 */
  textPreview: string;
  /** 来源 CodeAct taskId（观测/追踪用）。 */
  taskId?: string;
  /** Telegram forum topic id。 */
  messageThreadId?: number;
}

export interface PostTaskIncomingMessage {
  messageId: number;
  userId: number;
  username: string;
  textPreview: string;
  messageThreadId?: number;
}

interface BufferedMessage extends PostTaskIncomingMessage {
  at: number;
}

interface ActiveWindow {
  chatId: number;
  openedAt: number;
  expiresAt: number;
  hardExpireAt: number;
  /** bot 最近一条发言预览（judge 的锚点）。 */
  botAnchor: string;
  taskId?: string;
  messageThreadId?: number;
  buffered: BufferedMessage[];
  bufferedIds: Set<number>;
  /** 已分诊（judge 过或配额耗尽被丢弃）的消息 id —— 窗口内去重核心。 */
  judgedIds: Set<number>;
  continuations: number;
  tickTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  judgeInFlight: boolean;
}

interface JudgeDecision {
  hasFollowUp: boolean;
  triggerMessageId?: number;
  reason?: string;
}

export class PostTaskWindowManager {
  private readonly windows = new Map<number, ActiveWindow>();

  /** bot 发言成功 → 开窗口 / 顺延窗口并更新锚点。 */
  noteBotSpoke(chatId: number, info: BotSpokeInfo): void {
    if (!env().POST_TASK_WINDOW_ENABLED) return;
    // DM 里每条消息本来就会被 Meta 回，窗口只会造成双回 —— 只做群聊。
    if (!Number.isFinite(chatId) || !isGroup(chatId)) return;
    const windowMs = Math.max(1_000, env().POST_TASK_WINDOW_MS);
    const now = Date.now();

    const existing = this.windows.get(chatId);
    if (existing) {
      const anchor = (info.textPreview ?? '').trim();
      if (anchor) existing.botAnchor = anchor.slice(0, 300);
      if (info.taskId) existing.taskId = info.taskId;
      if (info.messageThreadId) existing.messageThreadId = info.messageThreadId;
      existing.expiresAt = Math.min(now + windowMs, existing.hardExpireAt);
      this.scheduleExpiry(existing);
      return;
    }

    const win: ActiveWindow = {
      chatId,
      openedAt: now,
      expiresAt: now + windowMs,
      hardExpireAt: now + Math.max(windowMs * 3, MIN_HARD_LIFETIME_MS),
      botAnchor: (info.textPreview ?? '').trim().slice(0, 300),
      taskId: info.taskId,
      messageThreadId: info.messageThreadId,
      buffered: [],
      bufferedIds: new Set(),
      judgedIds: new Set(),
      continuations: 0,
      tickTimer: null,
      expiryTimer: null,
      judgeInFlight: false,
    };
    this.windows.set(chatId, win);
    this.scheduleExpiry(win);
    logger.info({ chatId, windowMs }, 'post-task window opened');
  }

  /** Meta ingress 钩子：人类群消息入窗口缓冲（附加式，不影响主流）。 */
  ingestIncoming(chatId: number, msg: PostTaskIncomingMessage): void {
    if (!env().POST_TASK_WINDOW_ENABLED) return;
    const win = this.windows.get(chatId);
    if (!win) return;
    const mid = Math.floor(Number(msg.messageId));
    if (!Number.isFinite(mid) || mid <= 0) return;
    if (win.bufferedIds.has(mid) || win.judgedIds.has(mid)) return;
    if (win.buffered.length >= MAX_BUFFERED_MESSAGES) {
      const dropped = win.buffered.shift();
      if (dropped) {
        win.bufferedIds.delete(dropped.messageId);
        win.judgedIds.add(dropped.messageId);
      }
    }
    win.buffered.push({
      ...msg,
      messageId: mid,
      username: (msg.username ?? '').slice(0, 64),
      textPreview: (msg.textPreview ?? '').slice(0, 200),
      at: Date.now(),
    });
    win.bufferedIds.add(mid);
    if (msg.messageThreadId) win.messageThreadId = msg.messageThreadId;
    this.scheduleTick(win);
  }

  hasActiveWindow(chatId: number): boolean {
    return this.windows.has(chatId);
  }

  dispose(): void {
    for (const win of this.windows.values()) {
      if (win.tickTimer) clearTimeout(win.tickTimer);
      if (win.expiryTimer) clearTimeout(win.expiryTimer);
    }
    this.windows.clear();
  }

  private scheduleExpiry(win: ActiveWindow): void {
    if (win.expiryTimer) clearTimeout(win.expiryTimer);
    const delay = Math.max(0, win.expiresAt - Date.now());
    win.expiryTimer = setTimeout(() => this.close(win.chatId), delay);
    win.expiryTimer.unref?.();
  }

  private close(chatId: number): void {
    const win = this.windows.get(chatId);
    if (!win) return;
    if (win.tickTimer) clearTimeout(win.tickTimer);
    if (win.expiryTimer) clearTimeout(win.expiryTimer);
    this.windows.delete(chatId);
    logger.debug(
      { chatId, buffered: win.buffered.length, continuations: win.continuations },
      'post-task window closed',
    );
  }

  private scheduleTick(win: ActiveWindow, delayMs = TICK_MS): void {
    if (win.tickTimer || win.judgeInFlight) return;
    if (!win.buffered.some((m) => !win.judgedIds.has(m.messageId))) return;
    // 留 1ms 边距:别和到期关闭撞在同一拍(同 ms 定时器按创建顺序触发,到期必赢)。
    const remaining = win.expiresAt - Date.now() - 1;
    if (remaining <= 0) return;
    win.tickTimer = setTimeout(() => {
      void this.tick(win.chatId);
    }, Math.min(delayMs, remaining));
    win.tickTimer.unref?.();
  }

  private async tick(chatId: number): Promise<void> {
    const win = this.windows.get(chatId);
    if (!win) return;
    win.tickTimer = null;

    const candidates = win.buffered.filter((m) => !win.judgedIds.has(m.messageId));
    if (!candidates.length) return;

    // 配额耗尽：剩余消息直接分诊掉（留给正常 Meta 路径，不再判定）。
    if (win.continuations >= MAX_CONTINUATIONS_PER_WINDOW) {
      for (const m of candidates) win.judgedIds.add(m.messageId);
      return;
    }
    if (win.judgeInFlight) {
      this.scheduleTick(win, IDLE_RECHECK_MS);
      return;
    }

    win.judgeInFlight = true;
    try {
      const decision = await judgeFollowUpBatch(win, candidates);
      if (this.windows.get(chatId) !== win) return; // 判定期间窗口已关
      for (const m of candidates) win.judgedIds.add(m.messageId);
      if (!decision?.hasFollowUp) return;
      const trigger =
        candidates.find((m) => m.messageId === decision.triggerMessageId) ??
        candidates[candidates.length - 1];
      if (!trigger) return;
      await this.dispatchContinuation(win, trigger, decision.reason);
    } catch (err) {
      // judge/dispatch 失败：跳过这批（标已分诊防死循环），不往外抛。
      logger.warn({ err, chatId }, 'post-task follow-up batch failed — skipped');
      if (this.windows.get(chatId) === win) {
        for (const m of candidates) win.judgedIds.add(m.messageId);
      }
    } finally {
      win.judgeInFlight = false;
      if (
        this.windows.get(chatId) === win &&
        win.buffered.some((m) => !win.judgedIds.has(m.messageId))
      ) {
        this.scheduleTick(win);
      }
    }
  }

  /** 命中 follow-up → 绕过 Meta 直接补一轮 CodeAct，并把缓冲消息标 answered。 */
  private async dispatchContinuation(
    win: ActiveWindow,
    trigger: BufferedMessage,
    reason?: string,
  ): Promise<void> {
    win.continuations += 1;
    const others = win.buffered
      .map((m) => m.messageId)
      .filter((id) => id !== trigger.messageId);
    const who = trigger.username || `uid:${trigger.userId}`;
    const direction =
      `Post-task window 内 ${who} 接住了你刚说的话：「${trigger.textPreview.slice(0, 120)}」。` +
      '自然补一句回应 ta，别空问候。' +
      (reason ? `（判定：${reason.slice(0, 80)}）` : '');

    const task: DispatchTask = {
      id: randomUUID(),
      chatId: win.chatId,
      contentDirection: sanitizeContentDirection(direction, trigger.messageId),
      toneGuidance: '自然、简短，像被人接住话头一样顺势补一句；禁止复读自己上一句。',
      quoteMessageIds: [trigger.messageId],
      relatedQuoteIds: others.length ? others : undefined,
      targetUserId: trigger.userId > 0 ? trigger.userId : undefined,
      trackingKey: `post-task:${win.taskId ?? 'organic'}`,
      createdAt: Date.now(),
      status: 'queued',
      messageThreadId: win.messageThreadId,
    };

    // 先标 answered 再入队：Meta 路径看到已答就不会再回（防双回比漏标更要紧）；
    // CodeAct 成功后 host 侧会再标一遍（幂等）。
    await Promise.all(
      [trigger.messageId, ...others].map((mid) =>
        markMessageAnswered(win.chatId, mid).catch(() => undefined),
      ),
    );

    await enqueueCodeActJob(task);
    logger.info(
      { chatId: win.chatId, taskId: task.id, trigger: trigger.messageId, continuations: win.continuations },
      'post-task continuation dispatched',
    );
  }
}

/** 一次便宜的批量判定；失败抛出由调用方 fail-soft。 */
async function judgeFollowUpBatch(
  win: ActiveWindow,
  candidates: BufferedMessage[],
): Promise<JudgeDecision | null> {
  let systemPrompt = DEFAULT_FOLLOWUP_PROMPT;
  try {
    systemPrompt = loadCachedPrompt('task/post-task-followup.md') || DEFAULT_FOLLOWUP_PROMPT;
  } catch {
    /* prompt 文件缺失时用内置兜底 */
  }
  const lines = candidates.map(
    (m) => `[#${m.messageId} ${m.username || `uid:${m.userId}`}] ${m.textPreview || '(非文本)'}`,
  );
  const user = [
    'bot 刚发的消息:',
    `- "${win.botAnchor || '(贴纸/无文本)'}"`,
    '',
    '窗口内的新群消息:',
    ...lines,
    '',
    '这批新消息里有没有接住/追问 bot 的 follow-up？triggerMessageId 必须是上面 [#数字] 之一。只输出 JSON。',
  ].join('\n');

  const res = await callWithFallback({
    usage: env().POST_TASK_FOLLOWUP_USAGE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: user },
    ],
    maxTokens: 200,
    maxTimeoutMs: 10_000,
    allowHedge: false,
    rejectEmpty: true,
    chatId: win.chatId,
  });
  return parseJudgeResult(res.content);
}

function parseJudgeResult(raw: string): JudgeDecision | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
      parsed = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const hasRaw = parsed['hasFollowUp'] ?? parsed['has_follow_up'];
  const triggerRaw = parsed['triggerMessageId'] ?? parsed['trigger_message_id'];
  const triggerNum = triggerRaw != null ? Math.floor(Number(triggerRaw)) : NaN;
  return {
    hasFollowUp: hasRaw === true || hasRaw === 'true',
    triggerMessageId: Number.isFinite(triggerNum) && triggerNum > 0 ? triggerNum : undefined,
    reason: parsed['reason'] != null ? String(parsed['reason']).slice(0, 200) : undefined,
  };
}

// ── 单例 + fail-soft 包装（hook 点绝不能把异常漏进主流程） ──

let _manager: PostTaskWindowManager | undefined;

export function getPostTaskWindowManager(): PostTaskWindowManager {
  if (!_manager) _manager = new PostTaskWindowManager();
  return _manager;
}

export function _resetPostTaskWindowManager(): void {
  _manager?.dispose();
  _manager = undefined;
}

export function noteBotSpoke(chatId: number, info: BotSpokeInfo): void {
  try {
    getPostTaskWindowManager().noteBotSpoke(chatId, info);
  } catch (err) {
    logger.debug({ err, chatId }, 'post-task noteBotSpoke failed');
  }
}

export function ingestIncomingPostTask(chatId: number, msg: PostTaskIncomingMessage): void {
  try {
    getPostTaskWindowManager().ingestIncoming(chatId, msg);
  } catch (err) {
    logger.debug({ err, chatId }, 'post-task ingest failed');
  }
}
