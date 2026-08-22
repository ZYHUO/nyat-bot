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

/**
 * Transition to WAIT. Schedules a BullMQ delayed wait-resume job that will
 * fire after `waitSec` seconds. Bounds waitSec into [WAIT_MIN_SEC, WAIT_MAX_SEC].
 */
/** enqueueWaitResume 双失败时 WAIT 的硬上限(lazy-expire 兜底窗口)。 */
const WAIT_RESUME_FALLBACK_MS = 60_000;

export async function transitionToWait(
  chatId: number,
  waitSec: number,
  anchorMessageId?: number,
  triggerUid?: number,
  obligationId?: string,
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
  let waitUntilOverrideMs: number | undefined;
  try {
    waitJobId = await enqueueWaitResume(chatId, bounded, anchorMessageId, obligationId);
  } catch (err) {
    // 瞬时 Redis/BullMQ 故障 → 重试一次(codex #2:入队失败会让 chat 裸进 WAIT、
    // 锚点直到 direct 唤醒才replay;重试能救回大部分瞬时故障)。仍失败则退化为
    // silence-only WAIT(靠 direct 唤醒自愈),提到 error 级好盯。
    logger.warn({ err, chatId, bounded }, 'enqueueWaitResume failed, retrying once');
    try {
      waitJobId = await enqueueWaitResume(chatId, bounded, anchorMessageId, obligationId);
    } catch (err2) {
      // 双失败后把 waitUntil 钳到 1 分钟硬上限(P1 fix 2026-08-22 审查): 否则 chat 裸进
      // WAIT 且非 direct 消息被 waitTriggerUids 整人抑制——触发者若不再发 direct,
      // 要等 TIMING_STATE_TTL(24h)才自愈。钳短后 state-store 的 lazy-expire 分钟级兜底。
      logger.error({ err: err2, chatId, bounded }, 'enqueueWaitResume failed twice; entering WAIT clamped to 60s (lazy-expire fallback)');
      waitUntilOverrideMs = Date.now() + WAIT_RESUME_FALLBACK_MS;
    }
  }

  await enterWait(chatId, bounded, anchorMessageId, waitJobId, triggerUid, waitUntilOverrideMs);
  logger.info(
    { chatId, waitSec: bounded, anchorMessageId, waitJobId, triggerUid },
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
  waitResume?: { scheduledAt: number; waitSec: number; anchorMessageId?: number; obligationId?: string };
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

  // Meta path: re-ingest Attention so orchestrator can revisit after wait.
  if (env().META_SUBAGENT_ENABLED) {
    try {
      const { resumeMetaWaitAttention } = await import('../../meta/timing-adapter.js');
      const resumed = await resumeMetaWaitAttention(chatId);
      if (resumed) {
        logger.info({ chatId, anchorMessageId: waitResume?.anchorMessageId }, 'wait-resume → Meta Attention');
        return;
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'Meta wait-resume hook failed');
    }
  }

  // G5: 真正的 wait 回访 — 把 wait 时暂存的锚点条目重注入 pending,
  // 立即排程一个 wait_timeout 回合,带着完整语境重新决策(judge 仍可
  // 选择沉默;若期间话题已翻篇,actor 会让位给更新的消息重新锚定)。
  // 旧行为(flag off):只解除屏蔽,等下一条消息——"等一下"变成永久沉默。
  if (env().TURN_WAIT_RESUME_ENABLED && isTurnActorChat(chatId)) {
    try {
      const anchor = await takeWaitAnchor(chatId);
      if (anchor) {
        await appendPending({
          ...anchor,
          obligationId: waitResume?.obligationId ?? anchor.obligationId,
          // P2-F:把实际等待秒数与开始时刻盖到回放条目上 —— 写手侧提示
          // "你刚等了 N 秒";开始时刻供 actor 对照 activity 判断窗口期
          // 有没有人说话(review #7)。
          waitSec: waitResume?.waitSec ?? anchor.waitSec,
          waitStartedAt: waitResume?.scheduledAt ?? anchor.waitStartedAt,
        });
      }
      await scheduleTurn(chatId, {
        trigger: 'wait_timeout',
        delayMsOverride: 0,
        anchorMessageId: waitResume?.anchorMessageId,
        obligationId: waitResume?.obligationId,
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
