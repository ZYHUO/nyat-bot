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

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import {
  getChatState as storeGetChatState,
  enterRunning,
  enterStop,
  enterWait,
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

export type { ChatTimingState, RuntimeState };

/** Read current timing state. Returns RUNNING when state machine disabled. */
export async function getChatState(chatId: number): Promise<ChatTimingState> {
  if (!env().TIMING_GATE_ENABLED) {
    return { state: 'RUNNING' };
  }
  return storeGetChatState(chatId);
}

/** True when feature flag is on AND chat is currently in a "do not act" state. */
export async function isChatSuppressed(chatId: number): Promise<boolean> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) return false;
  const s = await storeGetChatState(chatId);
  return s.state === 'STOP' || s.state === 'WAIT';
}

/**
 * True when a recent gate decision was wait/no_action and we should NOT call
 * the gate LLM again immediately (cooldown). Returns false when feature off.
 */
export async function isInGateCooldown(chatId: number): Promise<boolean> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) return false;
  const cooldownMs = e.TIMING_GATE_COOLDOWN_SEC * 1000;
  if (cooldownMs <= 0) return false;
  const s = await storeGetChatState(chatId);
  if (
    s.lastGateAction === 'wait' ||
    s.lastGateAction === 'no_action'
  ) {
    if (s.lastGateAt && Date.now() - s.lastGateAt < cooldownMs) {
      return true;
    }
  }
  return false;
}

export async function transitionToRunning(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await enterRunning(chatId);
}

export async function transitionToStop(chatId: number): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;
  await enterStop(chatId);
  logger.info({ chatId }, 'Chat transitioned to STOP (gate=no_action)');
}

/**
 * Transition to WAIT. Schedules a BullMQ delayed wait-resume job that will
 * fire after `waitSec` seconds. Bounds waitSec into [WAIT_MIN_SEC, WAIT_MAX_SEC].
 */
export async function transitionToWait(
  chatId: number,
  waitSec: number,
  anchorMessageId?: number,
): Promise<void> {
  const e = env();
  if (!e.TIMING_GATE_ENABLED) return;

  const bounded = Math.min(
    Math.max(waitSec, e.TIMING_WAIT_MIN_SEC),
    e.TIMING_WAIT_MAX_SEC,
  );

  // Schedule resume job first so we can persist its id; if scheduling fails we
  // still mark the state but the chat will sit in WAIT until the next manual
  // wakeup (direct interaction).
  let waitJobId: string | undefined;
  try {
    waitJobId = await enqueueWaitResume(chatId, bounded, anchorMessageId);
  } catch (err) {
    logger.warn({ err, chatId, bounded }, 'enqueueWaitResume failed; entering WAIT without scheduled resume');
  }

  await enterWait(chatId, bounded, anchorMessageId, waitJobId);
  logger.info(
    { chatId, waitSec: bounded, anchorMessageId, waitJobId },
    'Chat transitioned to WAIT (gate=wait)',
  );
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

/**
 * Phase 4: handle a wait-resume job firing.
 *
 * Logic:
 *   1. Read current chat state.
 *   2. If state is no longer WAIT (e.g., direct interaction already woke it),
 *      this resume is stale — drop silently.
 *   3. If still WAIT, transition to RUNNING.
 *   4. We do NOT replay any specific message here. The next user message will
 *      flow through the normal pipeline; chat is just unblocked.
 *      If WAIT_RESUME_REPLAY behaviour is desired we can re-enqueue the
 *      anchor message later — kept simple for now to match MaiBot's
 *      "等待结束后接收新消息再思考"语义.
 */
export async function handleWaitResume(args: {
  chatId: number;
  waitResume?: { scheduledAt: number; waitSec: number; anchorMessageId?: number };
}): Promise<void> {
  if (!env().TIMING_GATE_ENABLED) return;

  const { chatId, waitResume } = args;
  const state = await storeGetChatState(chatId);

  // Stale resume: state is no longer WAIT (woken up by direct interaction)
  if (state.state !== 'WAIT') {
    logger.debug(
      { chatId, currentState: state.state },
      'wait-resume fired but chat no longer in WAIT, dropping',
    );
    return;
  }

  // Newer wait scheduled: this resume's job id doesn't match
  if (waitResume?.scheduledAt && state.waitUntil) {
    const expectedFireAt = waitResume.scheduledAt + waitResume.waitSec * 1000;
    if (Math.abs(expectedFireAt - state.waitUntil) > 2000) {
      logger.debug(
        { chatId, expectedFireAt, currentWaitUntil: state.waitUntil },
        'wait-resume fired but waitUntil mismatch (newer wait active), dropping',
      );
      return;
    }
  }

  await enterRunning(chatId);

  // G5: 真正的 wait 回访 — 把 wait 时暂存的锚点条目重注入 pending,
  // 立即排程一个 wait_timeout 回合,带着完整语境重新决策(judge 仍可
  // 选择沉默;若期间话题已翻篇,actor 会让位给更新的消息重新锚定)。
  // 旧行为(flag off):只解除屏蔽,等下一条消息——"等一下"变成永久沉默。
  if (env().TURN_WAIT_RESUME_ENABLED && isTurnActorChat(chatId)) {
    try {
      const anchor = await takeWaitAnchor(chatId);
      if (anchor) {
        await appendPending(anchor);
      }
      await scheduleTurn(chatId, {
        trigger: 'wait_timeout',
        delayMsOverride: 0,
        anchorMessageId: waitResume?.anchorMessageId,
      });
      logger.info(
        { chatId, anchorMessageId: waitResume?.anchorMessageId, replayed: !!anchor },
        'wait-resume → RUNNING + wait_timeout turn scheduled',
      );
      return;
    } catch (err) {
      logger.warn({ err, chatId }, 'wait-resume replay failed, chat unblocked only');
    }
  }

  logger.info(
    {
      chatId,
      anchorMessageId: waitResume?.anchorMessageId,
      waitSec: waitResume?.waitSec,
    },
    'wait-resume completed → chat transitioned to RUNNING',
  );
}
