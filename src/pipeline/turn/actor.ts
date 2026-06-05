// ────────────────────────────────────────
// Turn Actor — per-chat 认知回合主体
// ────────────────────────────────────────
//
// 回合开火时原子取走整个 pending burst,逐条喂给现有 processPipeline:
//   - direct 条目与最后一条 → 完整 judge→gate→reply(可被打断,G3)
//   - 其余 → tracking-only(与旧 debounce 的 isLastInBatch 语义 1:1)
//   - WAIT/STOP 且无 direct → 整批 tracking-only(与旧 ingress 抑制等价)
// 回合结束时若期间有新消息(dirty / pending 非空)→ 立即再排程,
// 保证同 chat 永远只有一个回合在跑(G12 的结构性解)。
//
// G3 打断闭环(MaiBot 语义):
//   ingress 新消息 → interruptGeneration → 写手调用以 AI_ABORTED 浮出 →
//   等静默期(用户这波话说完)→ 重排 pending → 以最新消息为锚、跳过
//   timing gate 重规划。连续打断受 TURN_INTERRUPT_MAX_CONSECUTIVE 约束,
//   超限后当前生成被放行(注册表层面拒绝打断)。

import type { MessageJobData } from '../../queue/jobs.js';
import { processPipeline } from '../pipeline.js';
import {
  drainPending,
  pendingCount,
  clearScheduledJob,
  clearDirty,
  bumpEpoch,
} from './buffer.js';
import { registerGeneration, clearGeneration } from './abort-registry.js';
import { waitForMessageQuiet } from './quiet-period.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { getChatState, transitionToRunning } from '../timing/chat-runtime.js';
import type { PendingEntry } from './types.js';
import { AIError } from '../../shared/errors.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

/** 单个 judged entry 的重规划上限(打断本身另有注册表层 cap) */
const MAX_REPLANS = 2;

export { isTurnActorChat } from './flags.js';

function isAbortError(err: unknown): boolean {
  return err instanceof AIError && err.code === 'AI_ABORTED';
}

/** Run one entry through the pipeline as tracking-only bookkeeping. */
async function trackEntry(chatId: number, entry: PendingEntry, batchSize: number, suppressed: boolean): Promise<void> {
  try {
    await processPipeline({
      type: 'message',
      chatId,
      messageId: entry.messageId,
      update: entry.update,
      enqueuedAt: entry.enqueuedAt,
      coalesce: {
        batchSize,
        isLastInBatch: false,
        flushReason: entry.direct ? 'direct_interaction' : 'window',
      },
      skipReply: suppressed ? true : undefined,
    });
  } catch (err) {
    logger.error({ err, chatId, messageId: entry.messageId }, 'Turn: tracking entry failed');
  }
}

/**
 * Run a judged entry with G3 interrupt semantics: register an interruptible
 * generation; on AI_ABORTED wait the quiet period, ingest the messages that
 * caused the interrupt, then replan anchored on the newest one with the
 * timing gate bypassed (MaiBot forced-continue).
 */
async function runJudgedEntry(
  chatId: number,
  entry: PendingEntry,
  batchSize: number,
  epoch: number,
  burstMessageIds: number[],
): Promise<void> {
  const e = env();
  let current = entry;
  let currentBatch = batchSize;
  let currentBurstIds = burstMessageIds;
  let gateBypass = false;
  let replans = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = registerGeneration(chatId, epoch);
    let interrupted = false;
    try {
      await processPipeline({
        type: 'message',
        chatId,
        messageId: current.messageId,
        update: current.update,
        enqueuedAt: current.enqueuedAt,
        coalesce: {
          batchSize: currentBatch,
          isLastInBatch: true,
          flushReason: current.direct ? 'direct_interaction' : 'window',
        },
        turnContext: {
          signal: controller.signal,
          epoch,
          // wait 回访跳过 gate:刚因 wait 沉默过,再问 gate 多半又是沉默
          gateBypass: gateBypass || current.waitReplay === true,
          isReplan: replans > 0,
          isWaitReplay: current.waitReplay === true,
          burstMessageIds: currentBurstIds.length > 1 ? currentBurstIds : undefined,
        },
      });
      return;
    } catch (err) {
      if (!isAbortError(err) || !e.TURN_ABORT_ENABLED || replans >= MAX_REPLANS) {
        if (isAbortError(err)) {
          // 重规划预算耗尽:静默放弃这一回合的发言(消息已入上下文,
          // 下一回合会带着完整语境重新决策)。
          logger.info({ chatId, replans }, 'Turn: replan budget exhausted, dropping reply');
          return;
        }
        throw err;
      }
      interrupted = true;
      replans++;

      // 等用户这一波消息发完(MaiBot post-interrupt 1s 静默期)
      await waitForMessageQuiet(chatId, e.TURN_INTERRUPT_QUIET_MS);

      // 消化打断期间的新消息:前段 tracking-only,最新一条成为新锚点;
      // burst 视野扩展为「原 burst + 打断新增」(都已在上下文里)
      const fresh = await drainPending(chatId);
      if (fresh.length > 0) {
        for (const ne of fresh.slice(0, -1)) {
          await trackEntry(chatId, ne, fresh.length, false);
        }
        current = fresh.at(-1)!;
        currentBatch = fresh.length;
        currentBurstIds = [
          ...currentBurstIds,
          ...fresh.map((f) => f.messageId).filter((id): id is number => id !== undefined),
        ];
      }
      // 无论是否有新消息,重规划都跳过 gate(打断已证明此刻该说话)
      gateBypass = true;
      logger.info(
        { chatId, replans, newAnchor: current.messageId, freshCount: fresh.length },
        'Turn: replanning after interrupt',
      );
    } finally {
      clearGeneration(chatId, controller, interrupted);
    }
  }
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

  const drained = await drainPending(chatId);
  if (drained.length === 0) {
    // Raced duplicate turn, or a wait/proactive trigger with nothing buffered.
    logger.debug({ chatId, trigger: turnPayload?.trigger }, 'Turn fired with empty buffer, exiting');
    return;
  }

  // G5: wait 回访让位 — 若同批里有比锚点更新的真实消息,旧锚点退位
  // (它的内容早已在上下文里;MaiBot timeout-with-new-messages 重锚定语义),
  // 但它的 id 仍留在 burst 窗口里供模型选目标。
  const hasFresh = drained.some((en) => !en.waitReplay);
  const displacedReplayIds = hasFresh
    ? drained.filter((en) => en.waitReplay).map((en) => en.messageId).filter((id): id is number => id !== undefined)
    : [];
  const entries = hasFresh ? drained.filter((en) => !en.waitReplay) : drained;

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
  const burstMessageIds = [
    ...displacedReplayIds,
    ...entries.map((en) => en.messageId).filter((id): id is number => id !== undefined),
  ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isFinal = i === entries.length - 1;
    const judgeThis = !suppressed && (entry.direct === true || isFinal);

    try {
      if (judgeThis) {
        await runJudgedEntry(chatId, entry, entries.length, epoch, burstMessageIds);
      } else {
        await trackEntry(chatId, entry, entries.length, suppressed);
      }
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
