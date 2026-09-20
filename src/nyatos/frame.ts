// Frame assembly: the single view a cognitive turn reads.
//
// WHY THIS EXISTS (NyatOS Phase 2)
//
// Today a decision is made in five places (L0 rules → L1 mini → L2 full →
// heart → gate), and each assembles its own partial picture from a different
// source. The Frame replaces that: one bounded, factual view assembled once and
// handed to a single decision point.
//
// WHAT IT IS
//
// Four registers, each with an existing owner — this module only reads and
// renders, it never decides:
//
//   field       ConversationField   (topics, floor, pace, unresolved, presence)
//   inner       InnerState          (attention/energy/curiosity/need)
//   capability  CapabilitySnapshot  (what Telegram actually permits)
//   self        self-history + clock (what I just did, when I'll think again)
//
// Plus the two facts a model most needs and currently lacks: what time it is,
// and how stale everything on screen is.
//
// WHAT IT IS NOT
//
// No thresholds, no "you should speak", no rule table. It reports; the model
// judges. Every register is bounded so a busy group cannot blow the budget.

import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';
import { collectConversationField, type ConversationField } from '../agent/conversation-field.js';
import type { TrenchReading } from './trench.js';
import { getLatestInnerState, getLatestCapabilitySnapshot } from '../agent/nyatos-state.js';
import { getSelfActSummary } from '../tracking/self-history.js';
import { nextSelfWake } from '../agent/cognitive-clock.js';
import type { InnerState } from '../agent/nyatos-contracts.js';
import {
  activeSpeechCooldownRemainingSec,
  getParticipationBudget,
  renderActiveSpeechSpacing,
  renderParticipationBudget,
  type ParticipationBudget,
} from './budget.js';

export interface FrameBudget {
  /** Recent messages included verbatim (as context lines). */
  maxMessages: number;
  /** Character cap for the whole rendered frame. */
  maxChars: number;
}

const DEFAULT_BUDGET: FrameBudget = { maxMessages: 20, maxChars: 4000 };

export interface Frame {
  schema: 'frame.v1';
  scope: CognitiveScope;
  asOf: number;
  /**
   * The bot's own identity. Without this the model cannot tell whether an
   * "@someone" in the transcript refers to itself — measured 2026-09-18: asked
   * about "@nyatbot 在吗" with no identity in the frame, it answered "这是@nyatbot
   * 的，和我无关，不用接" (silent), i.e. it failed to recognise its own name.
   */
  identity: { uid: number; username: string; displayName: string };
  /** Wall-clock facts the model currently cannot see. */
  clock: {
    nowIso: string;
    weekday: string;
    /** Seconds since the trigger message arrived. */
    triggerAgeSec: number;
    /** Seconds since the bot last spoke in this scope, if known. */
    sinceBotSpokeSec?: number;
  };
  field: ConversationField | null;
  inner: InnerState | null;
  capability: {
    chatKind: string;
    canSendText: boolean | null;
    canSendMedia: boolean | null;
    canReact: boolean | null;
    canPoll: boolean | null;
    isAdmin: boolean | null;
  } | null;
  self: {
    /** Bounded recent acts with outcomes, newest first. */
    recentActs: Array<{ minutesAgo: number; preview: string; outcome: string }>;
    /**
     * What the single decision point WANTED to do on recent messages, newest
     * first. This is the bot's own impulse history — it is not an action, it is
     * the thing the action layer never sees.
     *
     * Why it exists (2026-09-19): the NyatOS shadow records speak/silent/wait on
     * every message it observes (1,013 speak vs 35 silent over four days) and
     * **nothing ever reads it back**. So the reply path has no idea that the
     * decision point wanted to speak on 95% of messages — it cannot learn
     * restraint or eagerness from a history it cannot see. Exposing it here is
     * pure wiring: the data already exists, only the reader was missing.
     */
    recentImpulses?: Array<{
      minutesAgo: number;
      verdict: string;
      /** What the decision point said it wanted — its own words, unedited. */
      why: string;
    }>;
    /** When the bot told itself to think again. */
    pendingWake?: { minutesAhead: number; about?: string };
    /**
     * Remaining active-speech budget for this window, when the host enforces
     * one. Exposed so the model can spend it deliberately instead of being
     * silently blocked by a timer it cannot see.
     */
    budget?: ParticipationBudget;
    /** Nyat Trench L0 海床读数（宿主持有的有界积分器）。只读事实，不是配额。 */
    trench?: TrenchReading;
    /** 自我状态的一行身体感受（"这半小时几乎都是你在说，而且连着 3 条没人接"）。 */
    selfState?: string;
    /** 定向债的一行身体感受（"你睡着的时候 A（欠 2 句）——总共欠 3 句"）。 */
    debt?: string;
    /** 反广告事实（宿主只报行为，不给裁决）。未授权群不出现。 */
    adPressure?: string;
    /** 入群筛查事实（头像/名字形态/首次见到）。只报事实，不判定。 */
    joinScreen?: string;
    /** 注册表收集到的全部身体事实（按 order 排序）。 */
    bodyFacts?: string[];
    /** 回声的一行身体感受（"你最近说什么都没什么动静——但这不代表不该说"）。 */
    echo?: string;
    /** Seconds until another ACTIVE message is appropriate (0 = free now). */
    activeSpeechCooldownSec?: number;
    /** Things the bot said it would come back to, if any are worth raising. */
    openThreads?: string;
  };
  /**
   * Who the trigger message is addressed to, when it is addressed to someone
   * other than the bot. This is a reliable host-side detection (an @handle or a
   * reply-to), so it is reported as a fact rather than acted on with a hard
   * drop — measured 2026-09-18: told only the raw text, the model wanted to
   * "凑热闹" and answer questions aimed at other people.
   */
  addressedToOthers?: { handle: string };
  /** Recent messages, oldest first, already rendered as context lines. */
  recentLines: string[];
  /** Anything the host could not observe; the model should treat these as unknown. */
  unknowns: string[];
}

export interface BuildFrameInput {
  scope: CognitiveScope;
  trigger: FormattedMessage;
  recent: FormattedMessage[];
  botUid: number;
  /** Own username/display name, so the model recognises mentions of itself. */
  botUsername?: string;
  botDisplayName?: string;
  budget?: Partial<FrameBudget>;
  /**
   * 是否读"自己最近的冲动史"（social_prediction 账本）。
   * 默认 false：shadow 每条消息都会 buildFrame，而它自己不需要这份数据——
   * 只有把它渲染进生成 prompt 的调用方该付这次查询（2026-09-19 review 结论）。
   */
  withImpulses?: boolean;
  /** 是否读"自己约自己的唤醒"（self_scheduled_wake）。默认 false，理由同 withImpulses。 */
  withSelfWakes?: boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function clampBudget(input?: Partial<FrameBudget>): FrameBudget {
  const maxMessages = Number.isSafeInteger(input?.maxMessages) && (input?.maxMessages ?? 0) > 0
    ? Math.min(60, Math.max(1, Number(input?.maxMessages)))
    : DEFAULT_BUDGET.maxMessages;
  const maxChars = Number.isSafeInteger(input?.maxChars) && (input?.maxChars ?? 0) > 0
    ? Math.min(12_000, Math.max(500, Number(input?.maxChars)))
    : DEFAULT_BUDGET.maxChars;
  return { maxMessages, maxChars };
}

/** One context line. Newlines are inlined so a message cannot forge extra lines. */
function renderLine(msg: FormattedMessage, botUid: number): string {
  const when = new Date(msg.timestamp * 1000);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const who = msg.uid === botUid || msg.role === 'assistant'
    ? '你'
    : (msg.fullName || msg.username || String(msg.uid));
  const text = (msg.textContent || msg.captionContent || '')
    .replace(/[\r\n]+/g, ' ⏎ ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 300);
  return `[${hh}:${mm} #${msg.messageId}] ${who}: ${text}`;
}

/**
 * Assemble one bounded Frame.
 *
 * Fail-soft per register: if the field or inner state cannot be read, the frame
 * still renders with what is available and records the gap in `unknowns`.
 * A missing register must never block a decision — it just becomes an unknown
 * the model can see.
 */
export async function buildFrame(input: BuildFrameInput): Promise<Frame> {
  const budget = clampBudget(input.budget);
  const now = nowSec();
  const unknowns: string[] = [];
  const chatId = input.scope.chatId;

  // ── field ──
  let field: ConversationField | null = null;
  try {
    field = await collectConversationField({
      chatId: chatId ?? 0,
      recent: input.recent,
      botUid: input.botUid,
      ...(input.trigger.messageThreadId ? { threadId: input.trigger.messageThreadId } : {}),
      botAddressed: input.trigger.replyTo?.uid === input.botUid,
    });
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: conversation field unavailable');
    unknowns.push('群氛围场暂时读不到');
  }

  // ── inner ──
  let inner: InnerState | null = null;
  try {
    const record = getLatestInnerState(input.scope);
    if (record) inner = record.value;
    else unknowns.push('还没有内在状态投影（进程尚未唤醒过）');
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: inner state unavailable');
  }

  // ── capability ──
  let capability: Frame['capability'] = null;
  try {
    const record = getLatestCapabilitySnapshot(input.scope);
    if (record) {
      const v = record.value;
      capability = {
        chatKind: v.chatKind,
        canSendText: v.observed.canSendText,
        canSendMedia: v.observed.canSendMedia,
        canReact: v.observed.canReact,
        canPoll: v.observed.canPoll,
        isAdmin: v.admin ? v.admin.status === 'administrator' || v.admin.status === 'creator' : null,
      };
    } else {
      unknowns.push('还没有能力快照（没探测过本群权限）');
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: capability unavailable');
  }

  // ── self ──
  const self: Frame['self'] = { recentActs: [] };

  // Nyat Trench L0：海床读数。fail-soft——读不到就不加这一行，
  // 绝不让"身体读不到"变成"Frame 组装失败"。
  try {
    const { readTrench } = await import('./trench.js');
    self.trench = await readTrench(chatId ?? 0);
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: trench unavailable');
  }
  // 回声：E 标量（Echo 唯一的学习产出）。补上漏接的那一行。
  try {
    const { readEcho, renderEcho } = await import('../agent/echo.js');
    const e = await readEcho(chatId ?? 0);
    const line = renderEcho(e);
    if (line) self.echo = line;
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: echo unavailable');
  }
  // 定向债：睡眠期按发送者记的"欠谁一句"。衰减由还债驱动，不由时钟驱动。
  try {
    // ── 身体信号：全部走注册表，frame.ts 不再逐个 import ────────────
    //
    // 这一改是扩展性的核心：加一个新信号 = 一个模块文件 + 一行 registerBodySignal，
    // frame.ts 零改动。在此之前加"定向债"要改 10+ 个文件，加"反广告"又要再改一遍
    // frame 的类型/字段/渲染分支。
    //
    // 动态 import 各信号模块是为了触发它们的自注册（ESM 模块只执行一次，
    // 注册天然幂等）。registry 内部对重复 id 也有告警兜底。
    await Promise.all([
      import('./trench.js'),
      import('./debt.js'),
      import('./ad-pressure.js'),
    ]);
    // 入群筛查：nmnmfunbot 的"通过验证"消息带新成员名，按账号属性报三件事实
    // （有没有头像 / 名字形态 / 我们是否第一次见到它）。**只报事实，不判定。**
    // 用户明确排除机场/代理类——那个区分交给模型，宿主不写关键词表。
    try {
      const { extractJoinerName, readJoinSignals, renderJoinSignals }
        = await import('./join-signals.js');
      const { getBot } = await import('../bot/bot.js');
      for (const m of (input.recent ?? []).slice(-3)) {
        const joiner = extractJoinerName(String(m.textContent ?? ''));
        if (!joiner) continue;
        const uid = Number(m.uid ?? 0);
        if (!(uid > 0)) continue;
        const sig = await readJoinSignals(getBot(), uid, joiner);
        const line = renderJoinSignals(sig, joiner);
        if (line) self.joinScreen = line;
        break;   // 一回合只报一个新成员，别刷屏
      }
    } catch (err) {
      logger.debug({ err }, 'join screen frame render failed (non-critical)');
    }
    const { collectBodyFacts } = await import('./body-signal.js');
    // 本回合的发送者：per-(chat,sender) 类信号（反广告）需要它，群级信号忽略。
    const senders = (input.recent ?? [])
      .map((m) => ({ uid: Number(m.uid ?? 0), name: m.fullName ?? undefined }))
      .filter((c) => c.uid > 0)
      .slice(0, 3);
    const facts = await collectBodyFacts(chatId ?? 0, { senders });
    if (facts.length) self.bodyFacts = facts;
    // 兼容字段：debt/adPressure 仍写回 self，供既有消费方与测试读。
    const { renderAdPressure } = await import('./ad-pressure.js');
    const noise = await renderAdPressure(chatId ?? 0, senders).catch(() => '');
    if (noise) self.adPressure = noise;
    for (const f of facts) {
      if (f.startsWith('[欠话]')) self.debt = f;
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: debt unavailable');
  }
  // Nyat Trench 自我状态：决策点缺失的三个数（share30m / unansweredStreak / recentEcho）。
  // 这是 10.1% 一致率的直接病因——它不知道自己刚叭叭了一堆没人理。
  try {
    const { readSelfState, renderSelfState } = await import('./self-state.js');
    const st = readSelfState(chatId ?? 0);
    if (st) self.selfState = renderSelfState(st);
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: self state unavailable');
  }
  let sinceBotSpokeSec: number | undefined;
  try {
    // One read serves both "what I did" and "how long since I spoke".
    const summary = getSelfActSummary(chatId ?? 0, 45 * 60);
    if (summary) {
      self.recentActs = summary.recent.slice(0, 4).map((act) => ({
        minutesAgo: Math.max(1, Math.round((now - act.ts) / 60)),
        preview: act.text.slice(0, 48),
        outcome: act.outcome,
      }));
      sinceBotSpokeSec = summary.sinceLastSpokeSec;
    }
    // 自己的冲动史：单决策点最近想说什么。只读认知账本，读不到就不加这一段。
    try {
      const { getRecentImpulses } = await import('../agent/impulse-history.js');
      const impulses = getRecentImpulses(chatId ?? 0, 4, 90);
      if (impulses.length > 0) {
        self.recentImpulses = impulses.map((imp) => ({
          minutesAgo: Math.max(1, Math.round((now - imp.atSec) / 60)),
          verdict: imp.verdict,
          why: imp.why.slice(0, 90),
        }));
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'frame: impulse history unavailable');
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: self history unavailable');
  }
  try {
    const wake = nextSelfWake(input.scope, now);
    if (wake) {
      self.pendingWake = {
        minutesAhead: Math.max(1, Math.round((wake.wakeAt - now) / 60)),
        ...(wake.about ? { about: wake.about } : {}),
      };
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: pending wake unavailable');
  }
  try {
    const budget = await getParticipationBudget(chatId ?? 0);
    if (budget) self.budget = budget;
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: participation budget unavailable');
  }
  try {
    const cooldownSec = await activeSpeechCooldownRemainingSec(chatId ?? 0);
    if (cooldownSec > 0) self.activeSpeechCooldownSec = cooldownSec;
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: speech spacing unavailable');
  }
  try {
    const { listRaiseableThreads, renderOpenThreads } = await import('../tracking/open-threads.js');
    const rendered = renderOpenThreads(listRaiseableThreads(chatId ?? 0));
    if (rendered) self.openThreads = rendered;
  } catch (err) {
    logger.debug({ err, chatId }, 'frame: open threads unavailable');
  }

  // ── clock ──
  const nowDate = new Date(now * 1000);
  const clock: Frame['clock'] = {
    nowIso: `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(nowDate.getUTCDate()).padStart(2, '0')} ${String(nowDate.getUTCHours()).padStart(2, '0')}:${String(nowDate.getUTCMinutes()).padStart(2, '0')}`,
    weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][nowDate.getUTCDay()] ?? '',
    triggerAgeSec: Math.max(0, now - input.trigger.timestamp),
    ...(sinceBotSpokeSec === undefined ? {} : { sinceBotSpokeSec }),
  };

  // ── addressed to someone else ──
  let addressedToOthers: Frame['addressedToOthers'];
  try {
    const text = (input.trigger.textContent || input.trigger.captionContent || '');
    const handles = text.match(/@([A-Za-z][A-Za-z0-9_]{3,})/g) ?? [];
    const own = (input.botUsername ?? '').toLowerCase();
    const other = handles
      .map((h) => h.slice(1))
      .find((h) => h.toLowerCase() !== own);
    const replyToUid = input.trigger.replyTo?.uid;
    if (other) {
      addressedToOthers = { handle: `@${other}` };
    } else if (typeof replyToUid === 'number' && replyToUid > 0 && replyToUid !== input.botUid) {
      addressedToOthers = { handle: '另一位群友' };
    }
  } catch { /* optional fact */ }

  // ── recent lines ──
  const recentLines = input.recent.slice(-budget.maxMessages).map((m) => renderLine(m, input.botUid));

  return {
    schema: 'frame.v1',
    scope: input.scope,
    asOf: now,
    identity: {
      uid: input.botUid,
      username: input.botUsername ?? '',
      displayName: input.botDisplayName ?? '',
    },
    clock,
    field,
    inner,
    capability,
    self,
    ...(addressedToOthers ? { addressedToOthers } : {}),
    recentLines,
    unknowns,
  };
}

/**
 * Render a Frame as a bounded fact block.
 *
 * Everything here is a fact the host observed. There is deliberately no
 * instruction, no quota, and no "should" — the decision belongs to the caller.
 */
export function renderFrame(frame: Frame, budget?: Partial<FrameBudget>): string {
  const { maxChars } = clampBudget(budget);
  const lines: string[] = [];

  const ageText = frame.clock.triggerAgeSec < 60
    ? '刚刚'
    : `${Math.round(frame.clock.triggerAgeSec / 60)} 分钟前`;
  const spokeText = frame.clock.sinceBotSpokeSec === undefined
    ? ''
    : frame.clock.sinceBotSpokeSec < 90
      ? ' · 你刚刚说过话'
      : ` · 你上次说话 ${Math.round(frame.clock.sinceBotSpokeSec / 60)} 分钟前`;
  lines.push(`[现在] ${frame.clock.nowIso} ${frame.clock.weekday} · 这条消息 ${ageText}${spokeText}`);
  // Defensive: a Frame built before identity was added (or by a caller that did
  // not supply it) must still render rather than throw on the whole decision.
  const names = [
    frame.identity?.displayName,
    frame.identity?.username ? `@${frame.identity.username}` : '',
  ]
    .filter(Boolean)
    .join(' / ');
  if (names) lines.push(`[你是谁] 你是 ${names}。群里 @ 这两个名字就是在叫你。`);

  if (frame.field) {
    const f = frame.field;
    const bits = [
      `话题：${f.activeTopics.slice(0, 4).join('、') || '不明确'}`,
      `近一分钟 ${f.messagesLastMinute} 条`,
      `${f.uniqueHumanCount} 人在场`,
      `热度 ${f.temperature.toFixed(2)}`,
    ];
    if (f.unresolvedQuestions.length) bits.push(`悬着的问题 ${f.unresolvedQuestions.length} 个`);
    if (f.waitingBids.length) bits.push(`有人等着接话 ${f.waitingBids.length} 处`);
    lines.push(`[群里] ${bits.join(' · ')}`);

    // Who is talking to whom. The gate prompt encoded this as a RULE
    // ("群友们彼此在聊、不是在跟我聊 → no_action，别硬挤") and 121/122 of its
    // real LLM decisions just matched that rule. Reporting the structure as a
    // fact lets the model reach the same conclusion by understanding instead.
    const edges = f.addresseeEdges.filter((e) => e.confidence >= 0.5);
    const botEdges = edges.filter((e) => e.to === frame.identity.uid);
    const otherEdges = edges.filter((e) => e.to !== 'group' && e.to !== frame.identity.uid);
    if (botEdges.length > 0) {
      lines.push('[谁在跟谁说话] 有人把话递给你了。');
    } else if (otherEdges.length >= 2) {
      lines.push('[谁在跟谁说话] 群友之间在互相接话，没人把话递给你。');
    } else if (f.floorOwner !== undefined && f.floorOwner !== frame.identity.uid && otherEdges.length > 0) {
      lines.push('[谁在跟谁说话] 话头在别人手里，没人把话递给你。');
    }
  }

  if (frame.inner) {
    const i = frame.inner;
    lines.push(
      `[你的状态] 注意 ${i.attention.toFixed(2)} · 精力 ${i.energy.toFixed(2)} · 好奇 ${i.curiosity.toFixed(2)} · 连接 ${i.connection.toFixed(2)}`
      + (i.currentNeed ? ` · 此刻需要：${i.currentNeed}` : ''),
    );
  }

  if (frame.capability) {
    const c = frame.capability;
    const can = (v: boolean | null): string => (v === null ? '未知' : v ? '可以' : '不行');
    lines.push(
      `[你在本群能做的] 发文字 ${can(c.canSendText)} · 发媒体 ${can(c.canSendMedia)} · 投票 ${can(c.canPoll)} · 管理员 ${c.isAdmin === null ? '未知' : c.isAdmin ? '是' : '否'}`,
    );
  }

  if (frame.self.recentActs.length) {
    const label: Record<string, string> = {
      ignored: '没人接', replied: '有人回', reacted: '有人应',
      mentioned: '有人提到你', corrected: '被纠正', unknown: '还没结果',
    };
    const parts = frame.self.recentActs
      .map((a) => `${a.minutesAgo}分钟前「${a.preview}」→ ${label[a.outcome] ?? a.outcome}`);
    lines.push(`[你自己最近做的] ${parts.join('；')}`);
  }

  // 冲动史**不在这里渲染**。
  //
  // 2026-09-19：我加过一段 [念头]，后来追查真实注入文本时发现 room-awareness.ts
  // 早就有一段更好的 [你刚才的念头]——带计数概要（"最近 N 条里你有 M 次想接话"）
  // 和行为指引（"用它们判断我现在还想不想说"），数据和 why 文本完全相同。
  // 于是同一份冲动在 prompt 里出现两遍，白吃约 115 字预算。
  //
  // 而 renderFrame 的唯一冲动消费方就是 room-awareness（shadow 的 buildFrame
  // 不传 withImpulses，从来没见过这段），所以这里渲染等于纯重复。
  // recentImpulses 字段保留：它仍是 buildFrame 的产出，消费方在 room-awareness。
  if (frame.self.pendingWake) {
    lines.push(
      `[你自己定的下一次] ${frame.self.pendingWake.minutesAhead} 分钟后你打算再想想`
      + (frame.self.pendingWake.about ? `「${frame.self.pendingWake.about}」` : ''),
    );
  }
  const budgetLine = renderParticipationBudget(frame.self.budget ?? null);
  if (budgetLine) lines.push(budgetLine);
  // Nyat Trench L0：把宿主持有的有界积分器渲染成身体感受（不是配额）。
  if (frame.self.adPressure) lines.push(frame.self.adPressure);
  if (frame.self.joinScreen) lines.push(frame.self.joinScreen);
  // 身体信号统一来自注册表（trench / debt / ad-pressure / 未来新增的都在这里）。
  //
  // **self.debt / self.adPressure 仍要单独渲染**：它们是对外契约（测试与既有消费方
  // 直接设这两个字段），而注册表的 bodyFacts 可能已经含同一行——所以按内容去重，
  // 别把「欠话」印两遍。
  const fromRegistry = new Set(frame.self.bodyFacts ?? []);
  if (frame.self.adPressure && !fromRegistry.has(frame.self.adPressure)) {
    lines.push(frame.self.adPressure);
  }
  if (frame.self.bodyFacts?.length) lines.push(...frame.self.bodyFacts);
  if (frame.self.debt && !fromRegistry.has(frame.self.debt)) lines.push(frame.self.debt);
  if (frame.self.selfState) lines.push(frame.self.selfState);
  // 回声：E 标量的身体感受。**这一行原本漏了**——renderEcho 从写下起就没接进
  // Frame（2026-09-19 死代码扫描发现它是 TESTONLY），于是 E 在 Redis 里算、在学，
  // 模型却从未看见过它。一个观测不到自己的回声的人，学不到"我说的话有人接没人接"。
  if (frame.self.echo) lines.push(frame.self.echo);
  const spacingLine = renderActiveSpeechSpacing(frame.self.activeSpeechCooldownSec ?? 0);
  if (spacingLine) lines.push(spacingLine);
  if (frame.self.openThreads) lines.push(frame.self.openThreads);

  if (frame.unknowns.length) {
    lines.push(`[宿主没观察到的] ${frame.unknowns.join('；')}`);
  }

  if (frame.addressedToOthers) {
    lines.push(`[这条是说给谁的] 这条消息是问 ${frame.addressedToOthers.handle} 的，不是问你。`);
  }

  if (frame.recentLines.length) {
    lines.push('[最近的消息]');
    lines.push(...frame.recentLines);
  }

  const body = lines.join('\n');
  return body.length > maxChars ? body.slice(0, maxChars) : body;
}
