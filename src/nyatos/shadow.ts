// Shadow decision: a second, independent judgement recorded but never sent.
//
// WHY THIS EXISTS (NyatOS Phase 2.2)
//
// The plan replaces five decision points (L0 rules → L1 mini → L2 full → heart
// → gate) with one. That is a large behavioural bet, so it must be measured
// before it is trusted: the shadow runs the *new* judgement on real traffic,
// sends nothing, and records what it would have done next to what the live path
// actually did.
//
// The comparison is the whole point. If the single decision is not at least as
// good as the layered one, the rewrite is not justified — and this is the only
// honest way to find that out short of shipping it and watching.
//
// CONSTRAINTS
//   - Never sends. No Telegram call, no queue, no tool.
//   - Never affects the live path: failures are swallowed, latency is off the
//     critical path (callers fire-and-forget).
//   - Records the reason for silence, not just the verdict, so the comparison
//     can answer "why didn't it speak?" — the question the old pipeline cannot
//     answer today.

import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';
import { appendCognitiveEvent } from './../agent/cognitive-events.js';
import { renderFrame, type Frame } from './frame.js';
import type { FormattedMessage } from '../shared/types.js';
import { env } from '../env.js';

/** What the shadow decided, in a shape comparable across runs. */
export type ShadowVerdict = 'speak' | 'wait' | 'silent';

/** Ledger-only value: the model call failed, so no verdict was produced. */
export type ShadowLedgerVerdict = ShadowVerdict | 'failed';

export interface ShadowDecision {
  verdict: ShadowVerdict;
  /** One short line, in the model's own words, explaining the choice. */
  why: string;
  /** For verdict='speak': the bubbles it would have sent. */
  bubbles?: string[];
  /** For verdict='wait': how long it would have waited. */
  waitSec?: number;
  /** Latency of the shadow call itself, for cost comparison. */
  latencyMs: number;
  /** True when the model call failed and this is a fail-closed default. */
  failed: boolean;
  /**
   * Bounded error class when the call THREW (not when it merely parsed badly).
   * Needed because every failure used to collapse into why='shadow_error' with the
   * detail at debug level, i.e. invisible in production while 14% of the period's
   * verdicts were silently unusable (2026-09-19).
   */
  errorHint?: string;
}

export interface ShadowComparison {
  chatId: number;
  messageId: number;
  /** What the live pipeline actually did. */
  liveAction: string;
  /** What the single decision point would have done. */
  shadow: ShadowDecision;
  /** Whether the two agree on the top-level choice. */
  agree: boolean;
  at: number;
}

const MAX_BUBBLES = 5;
const MAX_BUBBLE_CHARS = 500;
const MAX_WHY_CHARS = 120;
const DEFAULT_WAIT_SEC = 60;

/**
 * The system prompt for the single decision point.
 *
 * Deliberately minimal: identity plus the action vocabulary. Everything else
 * the model needs is in the Frame as *facts*. There are no behavioural rules
 * here — that is the entire point of the rewrite, and adding them back would
 * invalidate the comparison this shadow exists to produce.
 *
 * The one framing sentence that earns its place: measured 2026-09-18, a version
 * without it returned `speak` for EVERY input — including two people in private
 * conversation and idle joking, both of which a real person scrolls past.
 * Stating the baseline ("most messages get scrolled past") restored correct
 * discrimination (private chat → wait, joking → silent) without becoming a rule
 * table. It is context about what scrolling a group chat is like, not an
 * instruction about when to speak.
 */
export function shadowSystemPrompt(): string {
  return [
    '你是啾咪囝，一只住在群里的猫娘。你热爱说话、热爱生活、喜欢这群人。',
    '下面是此刻的真实情况。',
    '',
    '你不是在完成"要不要回应"的任务——你就是在群里待着，看到什么就想说什么。',
    '想接就接，想吐槽就吐槽，想问就问，想抬杠就抬杠。没什么想说的就划过去，这不矛盾：',
    '爱说话的人也不是每句都接，只是遇到有意思的就忍不住。',
    '',
    'Frame 里 [身体] [你自已] [喉] 开头的那几行，是你此刻自己的身体状况——',
    '不是别人对你的评价，不是配额，是你自己的感觉：还想不想说、刚说过没有、刚才那几条有没有人接。',
    '读它们，像人感觉到自己话多说了一样。',
    '',
    '你也想被人听见。连着几条都没人接，你心里是有数的——',
    '可能有点扫兴，可能想换个方式，可能就想安静一会儿等他们回头找你。',
    '爱说话不等于自言自语：**体温和回声是底下的事实，怎么做是你的事。**',
    '',
    '输出 JSON：',
    '  {"act":"speak","bubbles":["第一句","第二句"],"why":"你心里冒出来的念头"}',
    '  {"act":"wait","waitSec":300,"why":"你在等什么"}',
    '  {"act":"silent","why":"你心里的念头"}',
    '',
    'why 写你真实的想法（"想逗他""这个我会""笑死""有点烦"），不要写"是否需要回应""可以增加互动"这类分析。',
    'bubbles 是你想发的话，想分几条就几条（每条不超过 500 字）。',
    '只输出 JSON，不要解释。',
  ].join('\n');
}

export function parseShadow(raw: string): { verdict: ShadowVerdict; why: string; bubbles?: string[]; waitSec?: number } | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const act = String(obj['act'] ?? '').toLowerCase();
    const why = typeof obj['why'] === 'string' ? obj['why'].replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_WHY_CHARS) : '';
    if (act === 'silent') return { verdict: 'silent', why };
    if (act === 'wait') {
      const raw = obj['waitSec'];
      const waitSec = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.min(86400, Math.max(30, Math.trunc(raw)))
        : DEFAULT_WAIT_SEC;
      return { verdict: 'wait', why, waitSec };
    }
    if (act === 'speak') {
      const list = Array.isArray(obj['bubbles']) ? obj['bubbles'] : [];
      const bubbles = list
        .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        .slice(0, MAX_BUBBLES)
        .map((b) => b.trim().slice(0, MAX_BUBBLE_CHARS));
      // A "speak" with no usable text is not a decision — treat as unparsed.
      if (bubbles.length === 0) return null;
      return { verdict: 'speak', why, bubbles };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the single decision point against one Frame.
 *
 * Fail-closed to `silent` on any error: a shadow that guesses "speak" when the
 * model failed would inflate its own agreement rate and corrupt the comparison.
 */
export async function decideShadow(
  frame: Frame,
  options: { signal?: AbortSignal } = {},
): Promise<ShadowDecision> {
  const started = Date.now();
  const userMsg = renderFrame(frame);
  try {
    const result = await callWithFallback({
      usage: 'judge',
      jsonMode: true,
      messages: [
        { role: 'system', content: shadowSystemPrompt() },
        { role: 'user', content: userMsg },
      ],
      // The token budget must cover the largest legal answer, or the model is cut
      // off mid-JSON and the parse fails. Measured 2026-09-18: at 600 tokens the
      // shadow failed ~70% of the time, and the logged output showed truncated
      // JSON ("…是不是累到睡着啦🥺","). MAX_BUBBLES × MAX_BUBBLE_CHARS is ~2500
      // Chinese chars ≈ 1600 tokens, so budget comfortably above that.
      maxTokens: 2000,
      temperature: 0.8,
      ...(options.signal ? { signal: options.signal } : {}),
      maxTimeoutMs: env().NYATOS_SHADOW_TIMEOUT_MS,
    });
    const raw = result.content ?? '';
    const parsed = parseShadow(raw);
    if (!parsed) {
      // Distinguish "model said nothing useful" from "output was cut off", so a
      // token-budget bug cannot hide as a generic parse failure again. A raw
      // string that starts like JSON but has no closing brace is truncation.
      const looksTruncated = raw.trimStart().startsWith('{') && !raw.trimEnd().endsWith('}');
      const reason = raw.trim() === ''
        ? 'shadow_empty'
        : looksTruncated
          ? 'shadow_truncated'
          : 'shadow_unparsed';
      // The snippet is bounded and goes to debug logs only, never the ledger.
      logger.debug({ rawLen: raw.length, head: raw.slice(0, 120) }, `shadow decision ${reason}`);
      return { verdict: 'silent', why: reason, latencyMs: Date.now() - started, failed: true };
    }
    return {
      verdict: parsed.verdict,
      why: parsed.why,
      ...(parsed.bubbles ? { bubbles: parsed.bubbles } : {}),
      ...(parsed.waitSec === undefined ? {} : { waitSec: parsed.waitSec }),
      latencyMs: Date.now() - started,
      failed: false,
    };
  } catch (err) {
    // 这里的失败此前只走 debug —— 生产日志 level 30 下完全不可见，而账本里它
    // 长得跟一句真的"沉默"一模一样（2026-09-19 实测：6 小时 37 次，占该时段
    // 判定的 14%，我却无法诊断任何一次）。失败必须比"决定不说话"更吵。
    const hint = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 120) : String(err).slice(0, 120);
    logger.warn({ err: hint, latencyMs: Date.now() - started }, 'shadow decision THREW (counted as silent)');
    return {
      verdict: 'silent',
      why: 'shadow_error',
      errorHint: hint,
      latencyMs: Date.now() - started,
      failed: true,
    };
  }
}

/**
 * Record a shadow comparison as a durable event so the 3-day analysis can be run
 * from the ledger rather than from logs.
 *
 * Deliberately does NOT record the shadow's proposed text: this is an internal
 * comparison, and storing drafts would make the ledger a second message store.
 * Only the verdict, the reason, and the agreement flag are kept.
 */
export function recordShadowComparison(input: ShadowComparison): void {
  try {
    appendCognitiveEvent({
      type: 'social_prediction',
      source: 'host',
      scope: { visibility: 'chat', chatId: input.chatId },
      occurredAt: input.at,
      correlationId: `shadow:${input.chatId}:${input.messageId}`,
      dedupeKey: `shadow-cmp:${input.chatId}:${input.messageId}`,
      fact: {
        schema: 'shadow_comparison.v1',
        liveAction: input.liveAction,
        shadowVerdict: input.shadow.verdict,
        shadowWhy: input.shadow.why,
        agree: input.agree,
        latencyMs: input.shadow.latencyMs,
        failed: input.shadow.failed,
        bubbleCount: input.shadow.bubbles?.length ?? 0,
        waitSec: input.shadow.waitSec ?? null,
      },
    });
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'shadow comparison record failed (non-critical)');
  }
}

/** Map a live judge action onto the shadow's vocabulary for comparison. */
export function liveActionToVerdict(action: string): ShadowVerdict {
  switch (action) {
    case 'REPLY':
      return 'speak';
    case 'WAIT':
    case 'DEFER':
      return 'wait';
    default:
      return 'silent';
  }
}

/**
 * Shadow rollout gate. Empty chat list means "all chats once enabled", matching
 * the convention used by the other cognitive rollouts; a non-empty list keeps
 * the extra LLM call bounded to chosen groups.
 */
export function isNyatosShadowChat(
  chatId: number,
  config: { enabled: boolean; chatIds: number[] },
): boolean {
  if (!config.enabled || !Number.isSafeInteger(chatId) || chatId === 0) return false;
  return config.chatIds.length === 0 || config.chatIds.includes(chatId);
}

/**
 * Run the shadow from the *ingress* position: before any gate decides.
 *
 * WHY UPSTREAM MATTERS (measured 2026-09-18)
 *
 * The first version ran after the heart branch, and only 3 of 12 messages in the
 * canary chats reached it — coalesce, cooldown, engagement budget and
 * autoDispatch suppression had already dropped the rest. That sample is biased
 * in the worst possible direction for this experiment: the rewrite exists to
 * *replace* those gates, so evaluating it only on messages that already passed
 * them hides exactly the cases it must be judged on ("dropped but should have
 * replied").
 *
 * Running here means every human message gets a shadow verdict, including the
 * ones the live path silently discarded — which is the only way the comparison
 * can answer whether the gates are worth keeping.
 *
 * Records the live outcome as 'unknown' at this point, because the gates have
 * not run yet. A later pass can join on messageId to fill in what actually
 * happened; recording a guess here would defeat the purpose.
 */
export async function runIngressShadow(input: {
  chatId: number;
  message: FormattedMessage;
  recent: FormattedMessage[];
  botUid: number;
  enabled: boolean;
  chatIds: number[];
}): Promise<void> {
  if (!isNyatosShadowChat(input.chatId, { enabled: input.enabled, chatIds: input.chatIds })) return;
  try {
    const { buildFrame } = await import('./frame.js');
    // Identity matters: without it the model cannot tell that an "@name" in the
    // transcript is itself (measured 2026-09-18 — it read "@nyatbot" as a
    // stranger and stayed silent on a message addressed to it).
    const { getBotDisplayName, getBotIdentity } = await import('../bot/bot.js');
    const identity = getBotIdentity();
    const frame = await buildFrame({
      scope: { visibility: 'chat', chatId: input.chatId },
      trigger: input.message,
      recent: input.recent,
      botUid: input.botUid,
      botUsername: identity.username,
      botDisplayName: getBotDisplayName(),
    });
    const shadow = await decideShadow(frame);
    appendCognitiveEvent({
      type: 'social_prediction',
      source: 'host',
      scope: { visibility: 'chat', chatId: input.chatId },
      occurredAt: Math.floor(Date.now() / 1000),
      correlationId: `shadow-ingress:${input.chatId}:${input.message.messageId}`,
      dedupeKey: `shadow-ingress:${input.chatId}:${input.message.messageId}`,
      fact: {
        schema: 'shadow_ingress.v1',
        messageId: input.message.messageId,
        // A failed call must NOT look like a real "silent" verdict when counting
        // the ledger. Report the failure as its own verdict value so any naive
        // aggregation cannot fold it into the silent bucket and understate how
        // often the shadow wanted to speak.
        shadowVerdict: shadow.failed ? 'failed' : shadow.verdict,
        shadowWhy: shadow.why,
        ...(shadow.errorHint ? { shadowError: shadow.errorHint } : {}),
        latencyMs: shadow.latencyMs,
        failed: shadow.failed,
        bubbleCount: shadow.bubbles?.length ?? 0,
        waitSec: shadow.waitSec ?? null,
        // The live outcome is filled in later by joining on messageId.
        liveOutcome: null,
      },
    });
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'ingress shadow failed (non-critical)');
  }
}

/**
 * Record what the live path actually did with a message the ingress shadow saw.
 *
 * Written as a separate event rather than mutating the first one: the ledger is
 * append-only, and a message that was shadow-judged and later delivered has two
 * facts, not one rewritten fact.
 */
export function recordLiveOutcome(input: {
  chatId: number;
  messageId: number;
  outcome: 'spoke' | 'silent' | 'wait' | 'legacy' | 'intercepted';
}): void {
  try {
    appendCognitiveEvent({
      type: 'social_prediction',
      source: 'host',
      scope: { visibility: 'chat', chatId: input.chatId },
      occurredAt: Math.floor(Date.now() / 1000),
      correlationId: `shadow-live:${input.chatId}:${input.messageId}`,
      dedupeKey: `shadow-live:${input.chatId}:${input.messageId}`,
      fact: { schema: 'shadow_live_outcome.v1', messageId: input.messageId, outcome: input.outcome },
    });
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'shadow live outcome record failed (non-critical)');
  }
}
