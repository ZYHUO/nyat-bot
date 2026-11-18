import type { PendingIntentRef } from './pending-intent.js';
// Meta path timing-gate adapter — reuse pipeline timing FSM without Turn Actor.
// L0 (incl. nickname): allow into Attention immediately — burst batching is
// META_L0_COALESCE_MS in Attention.flush (quiet window), NOT TIMING_TALK_VALUE
// / gate wait. Gate wait would drop mid-burst messages from Attention.
// L1/L2: continue → Attention; wait → WAIT + delayed reconsideration; no_action → silence.
//
// META_DEFER_ENABLED 开启后，canDefer=true 传给 runTimingGate，让 gate 的
// 冷却/talk-value 短路层产出 deferOnly 决策。deferOnly 由 scheduleMetaDeferReeval
// 排 Redis ZSET 延迟重评（metaTick 到点 drain 重新 ingest），而非永久丢弃。
// 这对齐了老版 pipeline + turn actor 的 defer-not-drop 语义。

import type { FormattedMessage, JudgeResult } from '../shared/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getBotDisplayName, getBotUid } from '../bot/bot.js';
import { runTimingGate } from '../pipeline/timing/gate.js';
import {
  getChatState,
  isChatSuppressed,
  recordGateContinue,
  recordBotReply,
  recordUserMessage,
  transitionToWait,
  cancelWaitForScope,
} from '../pipeline/timing/chat-runtime.js';
import { recordGateNoAction } from '../pipeline/timing/state-store.js';
import type { AttentionLayer } from './types.js';
import { getRedis } from '../db/redis.js';
import { scheduleMetaDeferReeval } from './defer.js';
import { dispatchWaitViaAgency } from '../agent/agency-wait-dispatch.js';
import { createHash, randomUUID } from 'node:crypto';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import type { ContextScope } from '../context-engine/scope.js';
import { resolveContextScope } from '../context-engine/scope.js';

export type MetaTimingVerdict = 'allow' | 'silence';

export interface MetaWaitAnchor {
  pendingIntent?: PendingIntentRef;
  messageThreadId?: number;
  chatId: number;
  layer: AttentionLayer;
  reason: string;
  messageId?: number;
  userId?: number;
  textPreview?: string;
  pressure?: number;
  createdAt: number;
  payload?: Record<string, unknown>;
  /** Durable Telegram event used to anchor workspace/replay reads. */
  cognitiveAnchorEventId?: string;
  waitGeneration?: string;
  contextScope?: ContextScope;
  /** Original host inputs, never reconstructed from a model's wait prose. */
  heartMessages?: FormattedMessage[];
  addressed?: boolean;
  ongoingFollowup?: boolean;
  targetMessageIds?: number[];
}

function waitAnchorKey(chatId: number, generation?: string): string {
  if (generation !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(generation)) throw Error('invalid_wait_generation');
  return `xxb:meta:wait-anchor:${chatId}${generation === undefined ? '' : `:${generation}`}`;
}

// A temporary Redis failure must not turn held work back into runnable input.
const pendingHeldAnchors = new Map<string, string>();
async function flushHeldAnchors(): Promise<void> {
  try {
    for (const [id, raw] of pendingHeldAnchors) {
      await getRedis().hsetnx('xxb:meta:activation-held', id, raw);
      pendingHeldAnchors.delete(id);
    }
  } catch {
    logger.warn({ pending: pendingHeldAnchors.size }, 'Meta wait archive unavailable; rejected anchors retained for retry');
  }
}

export async function setMetaWaitAnchor(anchor: MetaWaitAnchor, ttlSec: number): Promise<string> {
  const redis = getRedis();
  const waitGeneration = anchor.waitGeneration ?? randomUUID();
  const stored = { ...anchor, waitGeneration,
    contextScope: anchor.contextScope ?? resolveContextScope(anchor.chatId, anchor.messageThreadId) ?? undefined };
  await redis.set(waitAnchorKey(anchor.chatId, waitGeneration), JSON.stringify(stored), 'EX', Math.max(60, ttlSec));
  return waitGeneration;
}

export async function takeMetaWaitAnchor(chatId: number, generation?: string): Promise<MetaWaitAnchor | null> {
  try {
    const redis = getRedis();
    const key = waitAnchorKey(chatId, generation);
    // Atomic get-and-delete (Redis 6.2+ GETDEL): avoids the non-atomic
    // GET → DEL → JSON.parse race where a parse failure after DEL would
    // permanently lose the anchor. If parse fails the data is already
    // consumed (acceptable — better than silent loss via DEL-before-parse).
    const raw = await redis.getdel(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MetaWaitAnchor;
    } catch (err) {
      logger.warn({ err, chatId, key }, 'Meta wait anchor JSON parse failed (already consumed via GETDEL)');
      return null;
    }
  } catch {
    return null;
  }
}

export interface MetaWaitResume {
  waitGeneration?: string;
  anchorMessageId?: number;
  scheduledAt?: number;
  waitSec?: number;
}

/** A claimed timer permits reconsideration, never an unconditional reply. */
export async function resumeMetaWaitAttention(chatId: number, resume: MetaWaitResume = {}): Promise<boolean> {
  if (!env().META_SUBAGENT_ENABLED || !env().TIMING_GATE_ENABLED) return false;
  await flushHeldAnchors();
  const anchor = await takeMetaWaitAnchor(chatId, resume.waitGeneration);
  if (!anchor) return false;
  const decision = checkCodeActActivation(anchor);
  if (!decision.allowed || anchor.chatId !== chatId || !resume.waitGeneration
    || anchor.waitGeneration !== resume.waitGeneration || anchor.messageId !== resume.anchorMessageId) {
    const reason = !decision.allowed ? decision.reason : anchor.chatId !== chatId ? 'anchor_chat_mismatch' : 'wait_identity_unproven';
    const id = `wait:${createHash('sha256').update(JSON.stringify(anchor)).digest('hex')}`;
    pendingHeldAnchors.set(id, JSON.stringify({ kind: 'wait', reason, heldAt: Date.now(), input: anchor }));
    await flushHeldAnchors();
    logger.warn({ chatId, reason }, 'Meta wait anchor held before replay');
    // Handled, not resumed: the timing caller must not fall through to its
    // legacy Turn Actor replay after we reject the Meta anchor.
    return true;
  }
  try {
    const { recheckMetaWaitAnchor } = await import('./wait-recheck.js');
    await recheckMetaWaitAnchor(anchor, resume);
    return true;
  } catch (err) {
    logger.warn({ err, chatId }, 'Meta wait reconsideration unavailable; kept silent');
    return true;
  }
}

function stubJudge(isDirect: boolean): JudgeResult {
  return {
    action: 'REPLY',
    level: isDirect ? 'L0_RULE' : 'L1_MICRO',
    rule: isDirect ? 'private_chat' : 'meta_passive',
    latencyMs: 0,
  };
}

/**
 * Run timing gate for a Meta-path message before Attention ingest.
 *
 * META_DEFER_ENABLED 开启时传 canDefer=true 给 gate，让冷却/talk-value 短路层
 * 产出 deferOnly 决策（延迟重评而非永久丢弃），并对齐老版 pipeline 的
 * continuation 免检、talk-value 频率门控。关闭时保持旧行为（canDefer=false）。
 */
export async function evaluateMetaTiming(opts: {
  chatId: number;
  formatted: FormattedMessage;
  isDirect: boolean;
  layer: AttentionLayer;
  directKind?: string | null;
  /** 本条消息已被 defer 的次数（来自 Attention payload，首次为 0/undefined）。 */
  deferCount?: number;
  cognitiveAnchorEventId?: string;
  /** One expiry evaluation; a second wait means silence until fresh input. */
  waitResume?: boolean;
  isCurrent?: () => Promise<boolean>;
}): Promise<{ verdict: MetaTimingVerdict; reason: string }> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) {
    return { verdict: 'allow', reason: 'timing_disabled' };
  }

  const { chatId, formatted, isDirect, layer, directKind } = opts;
  const deferEnabled = !!e.META_DEFER_ENABLED;
  const deferCount = opts.deferCount ?? 0;

  if (!opts.waitResume) void recordUserMessage(chatId).catch(() => {});

  // L0 / hard-direct: ingest now. Multi-msg → one reply is Attention coalesce, not gate wait
  // (gate wait would drop mid-burst messages from the Attention queue).
  if (!opts.waitResume && (isDirect || layer === 'L0')) {
    try {
      await cancelWaitForScope(chatId, formatted.messageThreadId);
    } catch {
      /* non-critical */
    }
    return {
      verdict: 'allow',
      reason: directKind ? `l0:${directKind}` : 'direct_or_l0',
    };
  }

  try {
    if (await isChatSuppressed(chatId)) {
      logger.info({ chatId, layer }, 'Meta timing: chat suppressed, skip Attention');
      return { verdict: 'silence', reason: 'chat_suppressed' };
    }
  } catch {
    /* fail-open */
  }

  let recentMessages: FormattedMessage[] = [];
  try {
    const { getRecent } = await import('../pipeline/context/manager.js');
    recentMessages = await getRecent(chatId, 20, formatted.messageThreadId);
  } catch {
    recentMessages = [formatted];
  }

  let botPersona = '';
  try {
    const { loadCachedPrompt } = await import('../shared/config.js');
    // Timing 只要「回不回」——用精简 behavior-style；缺文件时回退 persona。
    try {
      botPersona = loadCachedPrompt('identity/behavior-style.md');
    } catch {
      botPersona = loadCachedPrompt('identity/persona.md');
    }
  } catch {
    /* optional */
  }

  let prefetchedState;
  let lastSpokeSecAgo: number | undefined;
  try {
    prefetchedState = await getChatState(chatId);
    if (prefetchedState.lastBotReplyAt) {
      lastSpokeSecAgo = (Date.now() - prefetchedState.lastBotReplyAt) / 1000;
    }
  } catch {
    /* optional */
  }

  const decision = await runTimingGate({
    chatId,
    message: formatted,
    recentMessages,
    judgeResult: stubJudge(false),
    botUid: getBotUid(chatId) || 0,
    botName: getBotDisplayName(chatId),
    botPersona,
    isDirectInteraction: false,
    lastSpokeSecAgo,
    prefetchedState,
    canDefer: deferEnabled,
    deferCount,
  });

  if (opts.isCurrent && !await opts.isCurrent()) return { verdict: 'silence', reason: 'wait_input_changed' };

  if (decision.action === 'continue') {
    if (!decision.continuation) {
      void recordGateContinue(chatId).catch(() => {});
    }
    logger.info(
      { chatId, layer, reason: decision.reason, shortCircuited: decision.shortCircuited },
      'Meta timing: continue',
    );
    return { verdict: 'allow', reason: decision.reason };
  }

  if (decision.action === 'wait') {
    if (opts.waitResume) return { verdict: 'silence', reason: 'wait_expired_still_waiting' };
    const waitSec = decision.waitSec ?? e.TIMING_WAIT_MIN_SEC;
    try {
      const waitGeneration = await setMetaWaitAnchor(
        {
          chatId,
          layer,
          reason: decision.reason,
          messageId: formatted.messageId,
          pendingIntent: formatted.pendingIntent, messageThreadId: formatted.messageThreadId,
          userId: formatted.uid,
          textPreview: (formatted.textContent || '').slice(0, 200),
          pressure: layer === 'L1' ? 60 : 30,
          createdAt: Date.now(),
          cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
          heartMessages: [formatted],
        },
        waitSec + 120,
      );
      const agencyWait = await dispatchWaitViaAgency({
        chatId,
        triggerMessageId: formatted.messageId,
        ...(formatted.uid > 0 ? { triggerUserId: formatted.uid } : {}),
        waitSec,
        reason: `meta_timing:${decision.reason}`,
        source: 'meta_timing',
        waitGeneration,
        messageThreadId: formatted.messageThreadId,
        ...(opts.cognitiveAnchorEventId ? { cognitiveAnchorEventId: opts.cognitiveAnchorEventId } : {}),
      });
      if (agencyWait.attempted) {
        if (!agencyWait.accepted) {
          logger.warn(
            { chatId, layer, messageId: formatted.messageId, agencyRunId: agencyWait.agencyRunId, reason: agencyWait.reason },
            'Meta timing wait rejected by Agency authority transport',
          );
          return { verdict: 'silence', reason: 'wait_transport_failed' };
        }
      } else {
        await transitionToWait(chatId, waitSec, formatted.messageId, formatted.uid, undefined,
          { waitGeneration, messageThreadId: formatted.messageThreadId });
      }
    } catch (err) {
      logger.warn({ err, chatId }, 'Meta timing wait setup failed; kept silent');
      return { verdict: 'silence', reason: 'wait_setup_failed' };
    }
    logger.info({ chatId, layer, waitSec, reason: decision.reason }, 'Meta timing: wait');
    return { verdict: 'silence', reason: `wait:${decision.reason}` };
  }

  // no_action — 可能是 deferOnly（冷却/talk-value/llm-failed），也可能是真正的 no_action
  if (decision.deferOnly && deferEnabled && !opts.waitResume) {
    const retryAfterMs = decision.retryAfterMs ?? 45_000;
    const scheduled = await scheduleMetaDeferReeval({
      chatId,
      entry: {
        chatId,
        layer,
        reason: decision.reason,
        messageId: formatted.messageId,
        pendingIntent: formatted.pendingIntent, messageThreadId: formatted.messageThreadId,
        userId: formatted.uid,
        textPreview: (formatted.textContent || '').slice(0, 200),
        pressure: layer === 'L1' ? 60 : 30,
        payload: {
          username: formatted.username || undefined,
          fullName: formatted.fullName || undefined,
          ...(formatted.replyTo
            ? {
                replyTo: {
                  messageId: formatted.replyTo.messageId,
                  uid: formatted.replyTo.uid,
                  fullName: formatted.replyTo.fullName,
                  textSnippet: (formatted.replyTo.textSnippet ?? '').slice(0, 200),
                },
              }
            : {}),
        },
        cognitiveAnchorEventId: opts.cognitiveAnchorEventId,
      },
      deferCount,
      retryAfterMs,
      reason: decision.reason,
    });
    if (scheduled) {
      logger.info(
        { chatId, layer, reason: decision.reason, retryAfterMs, deferCount },
        'Meta timing: defer → scheduled re-eval',
      );
      return { verdict: 'silence', reason: `defer:${decision.reason}` };
    }
    // 预算耗尽或 ZADD 失败 → 放行给 Attention（兜底是多回一次，不是丢消息）
    logger.info(
      { chatId, layer, reason: decision.reason, deferCount },
      'Meta timing: defer budget exhausted — fail-open allow',
    );
    return { verdict: 'allow', reason: `defer_exhausted:${decision.reason}` };
  }

  try {
    await recordGateNoAction(chatId, formatted.uid);
  } catch {
    /* non-critical */
  }
  logger.info({ chatId, layer, reason: decision.reason }, 'Meta timing: no_action');
  return { verdict: 'silence', reason: decision.reason };
}

/** Call after CodeAct successfully sends text — feeds continuation window. */
export async function noteMetaBotReply(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  try {
    await recordBotReply(chatId);
  } catch (err) {
    logger.debug({ err, chatId }, 'Meta noteMetaBotReply failed');
  }
}
