// ────────────────────────────────────────
// Turn Scheduler — 每 chat 最多一个排程中的认知回合
// ────────────────────────────────────────
//
// 不用固定 jobId 去重(BullMQ v5 同 jobId 的 add 返回旧 job 且不更新
// delay;completed/failed 未清理时还会堵死新回合)。改为显式状态机:
//   meta.scheduledJobId → getJob → getState:
//     delayed  → changeDelay 续期/提前(滑动去抖)
//     active   → markDirty(回合结束后由 actor 立即再排程)
//     其他/丢失 → 新建唯一 jobId 的 delayed job 并记录
//
// 去抖语义与原 in-memory debounce 1:1 对齐:
//   开火时间 = min(now + TIMING_DEBOUNCE_MS, firstPendingAt + MAX_BUFFER_MS)
//   direct 交互 → 立即开火。

import { getQueue } from './producer.js';
import type { MessageJobData } from './jobs.js';
import {
  getTurnMeta,
  setScheduledJob,
  markDirty,
} from '../pipeline/turn/buffer.js';
import { getFocus, debounceFactor } from '../pipeline/turn/focus.js';
import type { TurnTrigger } from '../pipeline/turn/types.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

let _seq = 0;

/** G4「还在打字」启发式:尾句无终止标点 → 滑动窗口放大,让这波念头落完 */
const STILL_TYPING_FACTOR = 1.75;

function computeFireDelay(
  firstPendingAt: number | undefined,
  direct: boolean,
  stillTyping: boolean,
  focusFactor: number,
): number {
  if (direct) return 0;
  const e = env();
  const now = Date.now();
  let sliding = stillTyping
    ? Math.round(e.TIMING_DEBOUNCE_MS * STILL_TYPING_FACTOR)
    : e.TIMING_DEBOUNCE_MS;
  // G9: focus 调制 — 聊得起劲回得快,半挂机多等等
  sliding = Math.round(sliding * focusFactor);
  const slidingFireAt = now + sliding;
  const hardFireAt = (firstPendingAt ?? now) + e.TIMING_DEBOUNCE_MAX_BUFFER_MS;
  return Math.max(0, Math.min(slidingFireAt, hardFireAt) - now);
}

export interface ScheduleTurnOptions {
  trigger: TurnTrigger;
  /** 覆盖计算出的延迟(wait_timeout / proactive 用) */
  delayMsOverride?: number;
  /** direct 交互:立即开火 + directPriority 标记 */
  direct?: boolean;
  /** wait 回合锚点 */
  anchorMessageId?: number;
  /** G4: 最新一条消息看起来没打完(无终止标点)→ 延长去抖窗口 */
  stillTyping?: boolean;
}

/**
 * Schedule (or reschedule) this chat's cognition turn.
 * Idempotent under races: a duplicate turn drains an empty buffer and exits.
 */
export async function scheduleTurn(chatId: number, opts: ScheduleTurnOptions): Promise<void> {
  const queue = getQueue();
  const meta = await getTurnMeta(chatId);
  let focusFactor = 1;
  if (env().TURN_FOCUS_ENABLED && !opts.direct && opts.delayMsOverride === undefined) {
    focusFactor = debounceFactor(await getFocus(chatId));
  }
  const delay = opts.delayMsOverride
    ?? computeFireDelay(meta.firstPendingAt, opts.direct ?? false, opts.stillTyping ?? false, focusFactor);

  // ── Try to reuse the already-scheduled job ──
  if (meta.scheduledJobId) {
    const job = await queue.getJob(meta.scheduledJobId).catch(() => undefined);
    if (job) {
      const state = await job.getState().catch(() => 'unknown');
      if (state === 'delayed') {
        try {
          // BullMQ changeDelay(delay) = "delay milliseconds FROM NOW,
          // regardless of the original delay"(job.ts 文档注释原话)。
          // 之前误以为相对 job.timestamp 而做了年龄补偿 → 活跃群每条新
          // 消息把回合推后 job 年龄那么久 → 回合永不开火、pending 爆仓。
          await job.changeDelay(delay);
          // direct 升级:已有排程但本次是 direct → 也把载荷升级为 directPriority
          if (opts.direct && !job.data.turn?.directPriority) {
            await job.updateData({
              ...job.data,
              turn: { ...job.data.turn!, directPriority: true, trigger: 'direct' },
            });
          }
          logger.debug({ chatId, jobId: job.id, delay, trigger: opts.trigger }, 'Turn rescheduled (changeDelay)');
          return;
        } catch (err) {
          // Promoted to active between getState and changeDelay — fall through.
          logger.debug({ err, chatId }, 'changeDelay raced with promotion, falling through');
        }
      }
      if (state === 'active' || state === 'waiting') {
        // 回合正在(或马上)跑:标脏,actor 收尾时会立即再排程。
        await markDirty(chatId);
        logger.debug({ chatId, jobId: job.id, state, trigger: opts.trigger }, 'Turn active, marked dirty');
        return;
      }
      // completed/failed/unknown → 新建
    }
  }

  // ── Create a fresh uniquely-id'd delayed turn job ──
  const jobId = `turn-${chatId}-${Date.now()}-${_seq++}`;
  const data: MessageJobData = {
    type: 'chat_turn',
    chatId,
    enqueuedAt: Date.now(),
    update: {} as MessageJobData['update'],
    turn: {
      trigger: opts.trigger,
      scheduledAt: Date.now(),
      directPriority: opts.direct ?? false,
      anchorMessageId: opts.anchorMessageId,
    },
  };

  await queue.add('chat_turn', data, {
    jobId,
    delay,
    // Turn jobs are high-churn one-shots — never let completed keys linger
    // (a retained key under a reused id would block future turns).
    removeOnComplete: true,
    removeOnFail: true,
  });
  await setScheduledJob(chatId, jobId);
  logger.debug({ chatId, jobId, delay, trigger: opts.trigger, direct: opts.direct }, 'Turn scheduled');
}
