// ────────────────────────────────────────
// Phase 2/4: ChatRuntime — high-level state-machine API
// ────────────────────────────────────────
//
// 这个文件不持有内存状态（一切在 Redis 里），它只是把 state-store 的原语
// 包装成场景化 API，并实现 wait-resume 逻辑（阶段 4）。
//
//   pipeline 调用：transitionToWait / transitionToStop / transitionToRunning
//   producer/handler 调用：getChatState（决定是否 bypass）
//   gate 调用：isInGateCooldown
//   worker 调用：handleWaitResume（delayed job 回调）
//   cron/idle 调用：getChatState（屏蔽 WAIT 状态）

import { randomUUID } from 'node:crypto';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import {
  getChatState as storeGetChatState,
  enterRunning,
  enterStop,
  beginScheduledWait,
  attachWaitJob,
  cancelWaitGeneration,
  claimWaitResume,
  recordContinue,
  recordBotReply as storeRecordBotReply,
  recordUserMessage as storeRecordUserMessage,
  type ChatTimingState,
  type RuntimeState,
} from './state-store.js';
import { enqueueWaitResume } from '../../queue/producer.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { appendPending, takeWaitAnchor } from '../turn/buffer.js';
import { isTurnActorChat } from '../turn/flags.js';
import { incrCounter } from '../../metrics/registry.js';

export type { ChatTimingState, RuntimeState };
export { cancelWaitForScope } from './state-store.js';

/** Read current timing state. Returns RUNNING when state machine disabled. */
export async function getChatState(chatId: number, strict = false): Promise<ChatTimingState> {
  if (!env().TIMING_GATE_ENABLED) {
    return { state: 'RUNNING' };
  }
  return storeGetChatState(chatId, strict);
}

/** True when feature flag is on AND chat is currently in a "do not act" state. */
export async function isChatSuppressed(chatId: number): Promise<boolean> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) return false;
  const s = await storeGetChatState(chatId);
  return s.state === 'STOP' || s.state === 'WAIT';
}

/**
 * P0-B:gate 冷却剩余毫秒(0 = 不在冷却)。指数退避逻辑与旧 isInGateCooldown
 * 完全一致,只是把布尔换成剩余时长 —— defer 延迟重评需要知道"还要等多久"。
 */
export async function getGateCooldownRemainingMs(
  chatId: number,
  prefetched?: ChatTimingState,
): Promise<number> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) return 0;
  const baseMs = e.TIMING_GATE_COOLDOWN_SEC * 1000;
  if (baseMs <= 0) return 0;
  // 审计 #38:心流分支一回合读同一 timing hash 3-4 次 → 调用方可传入
  // 已读快照,冷却判断与 lastSpokeSecAgo 共用一份
  const s = prefetched ?? await storeGetChatState(chatId);
  if (
    s.lastGateAction === 'wait' ||
    s.lastGateAction === 'no_action'
  ) {
    // 冷却是 per-chat 的(MaiBot 语义;review #5):曾有 per-uid 豁免
    // (lastGateUid !== triggerUid → 0),但多人群里发言者交替时互相豁免,
    // 指数退避形同虚设 → 每条消息都烧 LLM。per-person 的"等TA说完"语义
    // 由 actor 层 waitTriggerUids 抑制承担,不在冷却层重复。
    // 指数退避(MaiBot 借鉴):连续 no_action 时窗口 base*2^(n-start),
    // 封顶 CAP —— 沉默群里 gate 不再每 15s 白烧一次 LLM。wait 不参与
    // 退避(它有自己的 waitUntil 节奏)。direct 消息在 runTimingGate 的
    // 上游 short-circuit,不受冷却影响,@bot 永远立即唤醒。
    let cooldownMs = baseMs;
    if (s.lastGateAction === 'no_action' && (s.noActionCount ?? 0) > 0) {
      const over = Math.max(0, (s.noActionCount ?? 0) - e.NO_ACTION_BACKOFF_START_COUNT);
      cooldownMs = Math.min(baseMs * Math.pow(2, over), e.NO_ACTION_BACKOFF_CAP_SEC * 1000);
    }
    if (s.lastGateAt) {
      return Math.max(0, s.lastGateAt + cooldownMs - Date.now());
    }
  }
  return 0;
}

/**
 * True when a recent gate decision was wait/no_action and we should NOT call
 * the gate LLM again immediately (cooldown). Returns false when feature off.
 */
export async function isInGateCooldown(chatId: number, prefetched?: ChatTimingState): Promise<boolean> {
  return (await getGateCooldownRemainingMs(chatId, prefetched)) > 0;
}

/**
 * P0-A 连续对话免检(MaiBot 连续 Planner 状态):gate continue / bot 真实回复后
 * 窗口内的后续消息跳过 gate LLM —— 已经在对话中,不该反复自问"该不该说话"。
 * 纯函数:最新信号是正向(continue / bot 回复)且在窗口内才生效;更新的
 * wait/no_action 负向决策自动终止免检(no_action 后必须重新过闸)。
 */
export function isInContinuation(s: ChatTimingState, nowMs: number = Date.now()): boolean {
  const e = env();
  if (!e.TURN_GATE_CONTINUATION) return false;
  const windowMs = e.TIMING_CONTINUATION_WINDOW_SEC * 1000;
  const gateTs = s.lastGateAt ?? 0;
  const replyTs = s.lastBotReplyAt ?? 0;
  const newest = Math.max(gateTs, replyTs);
  if (newest <= 0 || nowMs - newest >= windowMs) return false;
  // 最新信号是负向 gate 决策 → 免检不生效
  if (gateTs >= replyTs && (s.lastGateAction === 'wait' || s.lastGateAction === 'no_action')) {
    return false;
  }
  return true;
}

export async function transitionToRunning(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await enterRunning(chatId);
}

export async function transitionToStop(chatId: number, triggerUid?: number, ttlSec?: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await enterStop(chatId, triggerUid, ttlSec);
  logger.info({ chatId, triggerUid, ttlSec }, 'Chat transitioned to STOP (gate=no_action)');
}

/** Install one wait identity before enqueueing; retries reuse its exact deadline. */
export async function transitionToWait(
  chatId: number,
  waitSec: number,
  anchorMessageId?: number,
  triggerUid?: number,
  obligationId?: string,
  options?: { waitGeneration?: string; messageThreadId?: number },
): Promise<void> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) return;
  if (!Number.isFinite(waitSec)) throw new Error('invalid_wait_duration');
  const bounded = Math.min(Math.max(waitSec, e.TIMING_WAIT_MIN_SEC), e.TIMING_WAIT_MAX_SEC);
  const waitGeneration = options?.waitGeneration ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(waitGeneration)) throw new Error('invalid_wait_generation');
  const scheduledAt = Date.now();
  const waitUntil = scheduledAt + Math.ceil(bounded * 1000);
  const timing = { waitGeneration, scheduledAt, waitUntil };
  await beginScheduledWait(chatId, { ...timing, anchorMessageId, triggerUid, messageThreadId: options?.messageThreadId });
  try {
    let waitJobId: string | undefined;
    try {
      waitJobId = await enqueueWaitResume(chatId, bounded, anchorMessageId, obligationId, timing);
    } catch (err) {
      logger.warn({ err, chatId }, 'enqueueWaitResume failed, retrying same generation');
      waitJobId = await enqueueWaitResume(chatId, bounded, anchorMessageId, obligationId, timing);
    }
    if (!waitJobId) throw new Error('wait_queue_receipt_missing');
    const current = await attachWaitJob(chatId, waitGeneration, waitJobId);
    logger.info({ chatId, waitSec: bounded, anchorMessageId, waitJobId, waitGeneration, current },
      current ? 'Chat transitioned to WAIT (gate=wait)' : 'Wait scheduled after cancellation or replacement; job fenced');
  } catch (err) {
    // A newer wait/cancellation must never be overwritten by this failed enqueue.
    await cancelWaitGeneration(chatId, waitGeneration);
    logger.error({ err, chatId, waitGeneration }, 'Wait scheduling failed; generation cancelled');
    throw err;
  }
}

export async function recordGateContinue(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await recordContinue(chatId);
}

export async function recordBotReply(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await storeRecordBotReply(chatId);
}

export async function recordUserMessage(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await storeRecordUserMessage(chatId);
}

/** Atomically claim the raw WAIT; expiry of the suppression view is not cancellation. */
export async function handleWaitResume(args: {
  chatId: number;
  jobId?: string;
  waitResume?: { scheduledAt: number; waitSec: number; anchorMessageId?: number; obligationId?: string;
    waitGeneration?: string; waitUntil?: number };
}): Promise<{ status: 'early'; waitUntil: number } | void> {
  if (!env().TIMING_GATE_ENABLED) return;
  const { chatId, waitResume } = args;
  if (!waitResume || !Number.isSafeInteger(waitResume.scheduledAt) || !Number.isFinite(waitResume.waitSec)
    || waitResume.waitSec < 0) {
    logger.warn({ chatId }, 'Wait resume rejected: invalid payload');
    return;
  }
  const claim = await claimWaitResume(chatId, { ...waitResume, jobId: args.jobId });
  if (claim.status === 'early') return { status: 'early', waitUntil: claim.waitUntil };
  if (claim.status !== 'claimed') {
    incrCounter('wait_resume_dropped_total', { chat: chatId });
    logger.info({ chatId, reason: claim.status }, 'Wait resume not current; no replay');
    return;
  }
  const generation = waitResume.waitGeneration;
  if (!generation) {
    // Old jobs can safely release their exact stored job id, but their shared
    // unversioned anchor cannot prove it belongs to this claim. Leave it to TTL.
    logger.warn({ chatId, jobId: args.jobId }, 'Legacy wait completed without replay: anchor generation unavailable');
    return;
  }
  try {
    if (env().META_SUBAGENT_ENABLED) {
      const { resumeMetaWaitAttention } = await import('../../meta/timing-adapter.js');
      if (await resumeMetaWaitAttention(chatId, { ...waitResume, waitGeneration: generation })) {
        logger.info({ chatId, waitGeneration: generation }, 'wait-resume handled by Meta');
        return;
      }
    }
    if (env().TURN_WAIT_RESUME_ENABLED && isTurnActorChat(chatId)) {
      const anchor = await takeWaitAnchor(chatId, generation);
      if (!anchor) return;
      // Cancellation/new input can race the anchor read. The actor and final
      // sender also fence this token before using the replayed input.
      const state = await storeGetChatState(chatId);
      if (state.state !== 'RUNNING' || state.waitGeneration !== generation) return;
      await appendPending({
        ...anchor, waitGeneration: generation,
        obligationId: waitResume.obligationId ?? anchor.obligationId,
        waitSec: waitResume.waitSec, waitStartedAt: waitResume.scheduledAt,
      });
      await scheduleTurn(chatId, { trigger: 'wait_timeout', delayMsOverride: 0,
        anchorMessageId: waitResume.anchorMessageId, obligationId: waitResume.obligationId });
      logger.info({ chatId, waitGeneration: generation }, 'wait-resume scheduled a fresh decision');
    }
  } catch (err) {
    // Claim is at-most-once. After downstream work starts its outcome may be
    // ambiguous, so automatic replay would risk duplicate reactions/replies.
    logger.error({ err, chatId, waitGeneration: generation }, 'Wait resume failed after claim; no automatic replay');
    incrCounter('wait_resume_failed_after_claim_total', { chat: chatId });
  }
}
