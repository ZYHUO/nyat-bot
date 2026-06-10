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
import { getLifeState } from '../tracking/life-state.js';
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
  // #5/#12 作息调速:深夜/吃饭/犯懒时整体慢半拍(direct 路径不经过这里)
  sliding = Math.round(sliding * getLifeState().speedFactor);
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
  /**
   * 跳过"复用已排程 job"分支,强制新建。回合尾声自我再排程必须用这个:
   * 此刻 meta 还指向**本回合自己**(active)→ 复用分支只会 markDirty,
   * 而本回合马上结束,没有任何人会再读这个 dirty → 消息永久挂起。
   */
  forceNew?: boolean;
  /**
   * 已有 delayed 回合时**不**滑动定时器(changeDelay 是"从现在起重新
   * 计时"):被动编辑入册用 —— 内容会被既有回合一并 drain,但连续改
   * typo 不该把真消息的回复一直往后推(review #2)。没有排程时照常新建。
   */
  noReschedule?: boolean;
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
  if (meta.scheduledJobId && !opts.forceNew) {
    const job = await queue.getJob(meta.scheduledJobId).catch(() => undefined);
    if (job) {
      const state = await job.getState().catch(() => 'unknown');
      if (state === 'delayed') {
        if (opts.noReschedule) {
          // 既有回合到点自会 drain pending 里的这条;不动它的定时器。
          logger.debug({ chatId, jobId: job.id, trigger: opts.trigger }, 'Turn untouched (noReschedule)');
          return;
        }
        try {
          // direct 升级先做:数据必须在 job 变为可提升之前就位(changeDelay(0)
          // 会让 job 立即可被 worker 拿走,之后再 updateData 就晚了)。
          if (opts.direct && !job.data.turn?.directPriority) {
            await job.updateData({
              ...job.data,
              turn: { ...job.data.turn!, directPriority: true, trigger: 'direct' },
            });
          }
          // BullMQ changeDelay(delay) = "delay milliseconds FROM NOW,
          // regardless of the original delay"(job.ts 文档注释原话)。
          // 之前误以为相对 job.timestamp 而做了年龄补偿 → 活跃群每条新
          // 消息把回合推后 job 年龄那么久 → 回合永不开火、pending 爆仓。
          await job.changeDelay(delay);
          logger.debug({ chatId, jobId: job.id, delay, trigger: opts.trigger }, 'Turn rescheduled (changeDelay)');
          return;
        } catch (err) {
          // TOCTOU:getState 和 changeDelay 之间 job 被提升(离开 delayed 集,
          // changeDelay 抛 JobNotInState/-3)。此刻它已经是 active/waiting —
          // 按 active 语义处理:标脏交给该回合收尾 forceNew 再排程。
          // **绝不能** fall through 去新建 job —— 那会造出第二个并行回合
          // (同群双回复,review-workflow P1)。
          logger.debug({ err, chatId }, 'changeDelay raced with promotion → markDirty');
          await markDirty(chatId);
          return;
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
