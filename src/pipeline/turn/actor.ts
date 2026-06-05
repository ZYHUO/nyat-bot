// ────────────────────────────────────────
// Turn Actor — per-chat 认知回合主体
// ────────────────────────────────────────
//
// S3 阶段:最小"旧管线等价"实现。回合开火时原子取走整个 pending burst,
// 逐条喂给现有 processPipeline:
//   - direct 条目与最后一条 → 完整 judge→gate→reply
//   - 其余 → tracking-only(与旧 debounce 的 isLastInBatch 语义 1:1)
//   - WAIT/STOP 且无 direct → 整批 tracking-only(与旧 ingress 抑制等价)
// 回合结束时若期间有新消息(dirty / pending 非空)→ 立即再排程,
// 保证同 chat 永远只有一个回合在跑(G12 的结构性解)。
//
// 后续阶段在此演进:S4 abort/freshness、S5 整 burst 判断、
// S6 wait 真回访、S8 动作空间、S9 自我接话。

import type { MessageJobData } from '../../queue/jobs.js';
import { processPipeline } from '../pipeline.js';
import {
  drainPending,
  pendingCount,
  clearScheduledJob,
  clearDirty,
  bumpEpoch,
} from './buffer.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { getChatState, transitionToRunning } from '../timing/chat-runtime.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

/** Is this chat routed through the turn actor (graylist-aware)? */
export function isTurnActorChat(chatId: number): boolean {
  const e = env();
  if (!e.TURN_ACTOR_ENABLED) return false;
  const graylist = e.TURN_ACTOR_CHAT_IDS;
  return graylist.length === 0 || graylist.includes(chatId);
}

/**
 * Run one cognition turn for a chat. Invoked by the BullMQ worker for
 * type='chat_turn' jobs. Idempotent: a duplicate/raced turn drains an
 * empty buffer and exits.
 */
export async function runChatTurn(data: MessageJobData, jobId?: string): Promise<void> {
  const chatId = data.chatId;
  const turnPayload = data.turn;
  const start = performance.now();

  // This job is now consuming the schedule slot — newer messages must
  // either changeDelay a fresh job or mark us dirty.
  await clearScheduledJob(chatId, jobId);

  const entries = await drainPending(chatId);
  if (entries.length === 0) {
    // Raced duplicate turn, or a wait/proactive trigger with nothing buffered.
    // wait_timeout / proactive semantics land in S6/S11.
    logger.debug({ chatId, trigger: turnPayload?.trigger }, 'Turn fired with empty buffer, exiting');
    return;
  }

  const epoch = await bumpEpoch(chatId);
  const e = env();
  const hasDirect = entries.some((entry) => entry.direct);

  // ── WAIT/STOP suppression (legacy ingress parity) ──
  // direct 在场 → 唤醒;否则整批 tracking-only,等 direct/wait 到期唤醒。
  let suppressed = false;
  if (e.TIMING_GATE_ENABLED) {
    try {
      const chatState = await getChatState(chatId);
      if (chatState.state === 'WAIT' || chatState.state === 'STOP') {
        if (hasDirect) {
          await transitionToRunning(chatId);
        } else {
          suppressed = true;
        }
      }
    } catch (err) {
      logger.warn({ err, chatId }, 'Turn: getChatState failed, treating as RUNNING');
    }
  }

  logger.debug(
    {
      chatId, epoch, burstSize: entries.length, hasDirect, suppressed,
      trigger: turnPayload?.trigger, directPriority: turnPayload?.directPriority,
    },
    'Turn started',
  );

  // ── Process the burst through the existing pipeline (legacy-equivalent) ──
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isFinal = i === entries.length - 1;
    const judgeThis = !suppressed && (entry.direct === true || isFinal);

    try {
      await processPipeline({
        type: 'message',
        chatId,
        messageId: entry.messageId,
        update: entry.update,
        enqueuedAt: entry.enqueuedAt,
        coalesce: {
          batchSize: entries.length,
          isLastInBatch: judgeThis,
          flushReason: entry.direct ? 'direct_interaction' : 'window',
        },
        skipReply: suppressed ? true : undefined,
      });
    } catch (err) {
      // One bad entry must not kill the rest of the burst.
      logger.error({ err, chatId, messageId: entry.messageId }, 'Turn: pipeline failed for entry');
    }
  }

  // ── Self-reschedule when messages landed mid-turn ──
  const wasDirty = await clearDirty(chatId);
  const stillPending = await pendingCount(chatId);
  if (wasDirty || stillPending > 0) {
    await scheduleTurn(chatId, { trigger: 'message' });
  }

  logger.debug(
    { chatId, epoch, burstSize: entries.length, rescheduled: wasDirty || stillPending > 0, totalMs: Math.round(performance.now() - start) },
    'Turn complete',
  );
}
