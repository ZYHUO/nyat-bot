// Meta path timing-gate adapter — reuse pipeline timing FSM without Turn Actor.
// L0 (incl. nickname): allow into Attention immediately — burst batching is
// META_L0_COALESCE_MS in Attention.flush (quiet window), NOT TIMING_TALK_VALUE
// / gate wait. Gate wait would drop mid-burst messages from Attention.
// L1/L2: continue → Attention; wait → WAIT + delayed re-ingest; no_action → silence.
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
  transitionToRunning,
} from '../pipeline/timing/chat-runtime.js';
import { recordGateNoAction } from '../pipeline/timing/state-store.js';
import type { AttentionLayer } from './types.js';
import { getRedis } from '../db/redis.js';
import { scheduleMetaDeferReeval } from './defer.js';

export type MetaTimingVerdict = 'allow' | 'silence';

export interface MetaWaitAnchor {
  chatId: number;
  layer: AttentionLayer;
  reason: string;
  messageId?: number;
  userId?: number;
  textPreview?: string;
  pressure?: number;
  createdAt: number;
  payload?: Record<string, unknown>;
}

function waitAnchorKey(chatId: number): string {
  return `xxb:meta:wait-anchor:${chatId}`;
}

export async function setMetaWaitAnchor(anchor: MetaWaitAnchor, ttlSec: number): Promise<void> {
  const redis = getRedis();
  await redis.set(waitAnchorKey(anchor.chatId), JSON.stringify(anchor), 'EX', Math.max(60, ttlSec));
}

export async function takeMetaWaitAnchor(chatId: number): Promise<MetaWaitAnchor | null> {
  try {
    const redis = getRedis();
    const key = waitAnchorKey(chatId);
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

/** After timing wait-resume: re-feed Attention so Meta can reconsider. */
export async function resumeMetaWaitAttention(chatId: number): Promise<boolean> {
  if (!env().META_SUBAGENT_ENABLED || !env().TIMING_GATE_ENABLED) return false;
  const anchor = await takeMetaWaitAnchor(chatId);
  if (!anchor) return false;
  try {
    const { getAttentionAccumulator } = await import('./attention.js');
    await getAttentionAccumulator().ingestAsync({
      chatId: anchor.chatId,
      layer: anchor.layer,
      reason: `wait_resume:${anchor.reason}`,
      messageId: anchor.messageId,
      userId: anchor.userId,
      textPreview: anchor.textPreview,
      pressure: anchor.pressure,
      payload: anchor.payload,
    });
    logger.info({ chatId, messageId: anchor.messageId }, 'Meta timing wait-resume → Attention');
    return true;
  } catch (err) {
    logger.warn({ err, chatId }, 'Meta timing wait-resume ingest failed');
    return false;
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
}): Promise<{ verdict: MetaTimingVerdict; reason: string }> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) {
    return { verdict: 'allow', reason: 'timing_disabled' };
  }

  const { chatId, formatted, isDirect, layer, directKind } = opts;
  const deferEnabled = !!e.META_DEFER_ENABLED;
  const deferCount = opts.deferCount ?? 0;

  void recordUserMessage(chatId).catch(() => {});

  // L0 / hard-direct: ingest now. Multi-msg → one reply is Attention coalesce, not gate wait
  // (gate wait would drop mid-burst messages from the Attention queue).
  if (isDirect || layer === 'L0') {
    try {
      if (await isChatSuppressed(chatId)) {
        await transitionToRunning(chatId);
      }
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
    botUid: getBotUid() || 0,
    botName: getBotDisplayName(),
    botPersona,
    isDirectInteraction: false,
    lastSpokeSecAgo,
    prefetchedState,
    canDefer: deferEnabled,
    deferCount,
  });

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
    const waitSec = decision.waitSec ?? e.TIMING_WAIT_MIN_SEC;
    try {
      await setMetaWaitAnchor(
        {
          chatId,
          layer,
          reason: decision.reason,
          messageId: formatted.messageId,
          userId: formatted.uid,
          textPreview: (formatted.textContent || '').slice(0, 200),
          pressure: layer === 'L1' ? 60 : 30,
          createdAt: Date.now(),
        },
        waitSec + 120,
      );
      await transitionToWait(chatId, waitSec, formatted.messageId, formatted.uid);
    } catch (err) {
      logger.warn({ err, chatId }, 'Meta timing wait setup failed — fail-open allow');
      return { verdict: 'allow', reason: 'wait_setup_failed' };
    }
    logger.info({ chatId, layer, waitSec, reason: decision.reason }, 'Meta timing: wait');
    return { verdict: 'silence', reason: `wait:${decision.reason}` };
  }

  // no_action — 可能是 deferOnly（冷却/talk-value/llm-failed），也可能是真正的 no_action
  if (decision.deferOnly && deferEnabled) {
    const retryAfterMs = decision.retryAfterMs ?? 45_000;
    const scheduled = await scheduleMetaDeferReeval({
      chatId,
      entry: {
        chatId,
        layer,
        reason: decision.reason,
        messageId: formatted.messageId,
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
