// ────────────────────────────────────────
// Meta dispatch 期 timing gate —— 老 pipeline「judge=REPLY 之后、reply 之前」
// 节奏闸在 meta+subagent 世界的等价物。
// ────────────────────────────────────────
//
// 背景：meta 路径里 L0/direct 在 ingest 期短路 allow（timing-adapter.ts），
// Heart 路径明示「Heart 本身就是 gate」跳过 evaluateMetaTiming —— 结果是
// runTimingGate 在生产零调用，节奏退化成 heart refractory + coalesce 固定窗，
// 老 gate 的 wait(N)/presence/gate-history/talk-value/continuation 全部失效。
//
// 本模块把 gate 挂到 CodeAct dispatch 前：Heart/Meta 决定「说不说」，
// 本 gate 决定「什么时候说」。bypass 语义对齐老 gate：
//   - L0（DM/@/回复 bot/昵称/命令）→ bypass（direct_interaction_bypass）
//   - L1_CALLBACK（任务结果汇报）→ bypass（用户在等结果，不受闲聊节奏压制）
//   - 其余（heart 插话 / Meta LLM gap-fill 闲聊）→ runTimingGate 全量短路层
//
// 决策映射：
//   continue    → allow（非 continuation 短路才 recordGateContinue —— 免检不续窗）
//   wait(N)     → meta wait-anchor + transitionToWait → suppress
//                 （wait-resume 链路 handleWaitResume → resumeMetaWaitAttention 到点
//                 重新 ingest，不丢消息）
//   no_action + deferOnly（冷却/talk-value/llm-failed）→ scheduleMetaDeferReeval
//                 → suppress；预算耗尽/ZADD 失败 → fail-open allow（宁可多说不吞）
//   no_action（真）→ recordGateNoAction + markMessageAnswered → suppress
//   任何基础设施异常 → fail-open allow

import type { FormattedMessage, JudgeResult } from '../shared/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getBotDisplayName, getBotUid } from '../bot/bot.js';
import { runTimingGate } from '../pipeline/timing/gate.js';
import {
  getChatState,
  recordGateContinue,
  transitionToWait,
} from '../pipeline/timing/chat-runtime.js';
import { recordGateNoAction } from '../pipeline/timing/state-store.js';
import { setMetaWaitAnchor } from './timing-adapter.js';
import { scheduleMetaDeferReeval } from './defer.js';
import type { AttentionLayer } from './types.js';

export type DispatchGateVerdict = 'allow' | 'suppress';

export interface DispatchGateResult {
  verdict: DispatchGateVerdict;
  reason: string;
}

export async function evaluateDispatchGate(opts: {
  chatId: number;
  layer: AttentionLayer;
  /** 触发来源（heart:… / meta_llm_dispatch / defer_replay:…），进 anchor/defer 条目。 */
  reason: string;
  messageId?: number;
  userId?: number;
  textPreview?: string;
  messageThreadId?: number;
  payload?: Record<string, unknown>;
  /** 本条消息已被 defer 的次数（defer 重放时从 payload 带出，首次为 0）。 */
  deferCount?: number;
}): Promise<DispatchGateResult> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED || !e.META_DISPATCH_GATE_ENABLED) {
    return { verdict: 'allow', reason: 'dispatch_gate_disabled' };
  }

  const { chatId, layer } = opts;
  if (layer === 'L0') return { verdict: 'allow', reason: 'l0_direct_bypass' };
  if (layer === 'L1_CALLBACK') return { verdict: 'allow', reason: 'callback_bypass' };

  try {
    let recentMessages: FormattedMessage[] = [];
    try {
      const { getRecent } = await import('../pipeline/context/manager.js');
      recentMessages = await getRecent(chatId, 20);
    } catch {
      recentMessages = [];
    }

    // 触发消息：优先从最近上下文里找 quote 原句（gate 的 slimContextForAI 要打 ★），
    // 找不到（meta-api 薄上下文调用）用 textPreview 合成最小 FormattedMessage。
    const quoted = opts.messageId
      ? recentMessages.find((m) => m.messageId === opts.messageId)
      : undefined;
    const trigger: FormattedMessage = quoted ?? {
      role: 'user',
      uid: opts.userId ?? 0,
      username: typeof opts.payload?.['username'] === 'string' ? opts.payload['username'] : '',
      fullName: typeof opts.payload?.['fullName'] === 'string' ? opts.payload['fullName'] : '',
      timestamp: Math.floor(Date.now() / 1000),
      messageId: opts.messageId ?? 0,
      textContent: opts.textPreview ?? '',
      isForwarded: false,
      ...(opts.messageThreadId ? { messageThreadId: opts.messageThreadId } : {}),
    };
    if (recentMessages.length === 0) recentMessages = [trigger];

    let botPersona = '';
    try {
      const { loadCachedPrompt } = await import('../shared/config.js');
      // Timing 只要「什么时候说」——用精简 behavior-style；缺文件时回退 persona。
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

    // 「说」的决定已经做出（heart reply / Meta LLM dispatch），gate 只看时机。
    const judgeResult: JudgeResult = {
      action: 'REPLY',
      level: 'L1_MICRO',
      rule: 'meta_dispatch',
      latencyMs: 0,
    };

    const decision = await runTimingGate({
      chatId,
      message: trigger,
      recentMessages,
      judgeResult,
      botUid: getBotUid() || 0,
      botName: getBotDisplayName(),
      botPersona,
      isDirectInteraction: false,
      lastSpokeSecAgo,
      prefetchedState,
      canDefer: !!e.META_DEFER_ENABLED,
      deferCount: opts.deferCount ?? 0,
    });

    if (decision.action === 'continue') {
      if (!decision.continuation) {
        void recordGateContinue(chatId).catch(() => {});
      }
      logger.info(
        { chatId, layer, reason: decision.reason, shortCircuited: decision.shortCircuited },
        'dispatch gate: continue',
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
            // 保留来源 reason（heart:…），wait-resume 重 ingest 后
            // autoDispatch 的 heartForce 判断（reason.includes('heart:')）才能再接住。
            reason: `dispatch_gate:${opts.reason}`,
            messageId: opts.messageId,
            userId: opts.userId,
            textPreview: (opts.textPreview ?? '').slice(0, 200),
            pressure: layer === 'L1' ? 60 : 30,
            createdAt: Date.now(),
            payload: opts.payload,
          },
          waitSec + 120,
        );
        await transitionToWait(chatId, waitSec, opts.messageId, opts.userId);
      } catch (err) {
        logger.warn({ err, chatId }, 'dispatch gate wait setup failed — fail-open allow');
        return { verdict: 'allow', reason: 'wait_setup_failed' };
      }
      logger.info({ chatId, layer, waitSec, reason: decision.reason }, 'dispatch gate: wait');
      return { verdict: 'suppress', reason: `wait:${decision.reason}` };
    }

    // no_action —— 可能是 deferOnly（冷却/talk-value/llm-failed），也可能是真的别说
    if (decision.deferOnly && e.META_DEFER_ENABLED) {
      const scheduled = await scheduleMetaDeferReeval({
        chatId,
        entry: {
          chatId,
          layer,
          // 同上：保留来源 reason 让 defer 重放能被 autoDispatch 的 heartForce 接住。
          reason: `dispatch_gate:${opts.reason}`,
          messageId: opts.messageId,
          userId: opts.userId,
          textPreview: (opts.textPreview ?? '').slice(0, 200),
          pressure: layer === 'L1' ? 60 : 30,
          payload: opts.payload,
        },
        deferCount: opts.deferCount ?? 0,
        retryAfterMs: decision.retryAfterMs ?? 45_000,
        reason: decision.reason,
      });
      if (scheduled) {
        logger.info(
          { chatId, layer, reason: decision.reason, retryAfterMs: decision.retryAfterMs },
          'dispatch gate: defer → scheduled re-eval',
        );
        return { verdict: 'suppress', reason: `defer:${decision.reason}` };
      }
      // 预算耗尽或 ZADD 失败 → 放行 dispatch（兜底是多回一次，不是丢消息）
      logger.info(
        { chatId, layer, reason: decision.reason },
        'dispatch gate: defer budget exhausted — fail-open allow',
      );
      return { verdict: 'allow', reason: `defer_exhausted:${decision.reason}` };
    }

    try {
      await recordGateNoAction(chatId, opts.userId);
    } catch {
      /* non-critical */
    }
    // 标已答，防下一 tick 对同一条消息重复 gate / 重复 dispatch。
    if (opts.messageId && opts.messageId > 0) {
      try {
        const { markMessageAnswered } = await import('./answered.js');
        await markMessageAnswered(chatId, opts.messageId);
      } catch {
        /* non-critical */
      }
    }
    logger.info({ chatId, layer, reason: decision.reason }, 'dispatch gate: no_action');
    return { verdict: 'suppress', reason: `no_action:${decision.reason}` };
  } catch (err) {
    logger.warn({ err, chatId: opts.chatId }, 'dispatch gate failed — fail-open allow');
    return { verdict: 'allow', reason: 'gate_error_failopen' };
  }
}
