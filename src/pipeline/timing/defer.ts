// ────────────────────────────────────────
// P0-B: gate defer = 延迟重评(MaiBot delayed-task 语义)
// ────────────────────────────────────────
//
// MaiBot 在退避/未达阈值时不丢消息:挂 delayed task 到点带着 pending 消息
// 重新走完整评估(runtime.py:1096-1101/1494-1504)。旧 TURN_GATE_DEFER_COOLDOWN
// 的 deferOnly 是"这条不回了"—— 静默丢弃。这里把它升级成:把条目重新 append
// 进 pending,并在 retryAfterMs 后排一个 gate_defer 回合;到点冷却已过/消息
// 已攒够,gate 全新评估(judge 首轮已判过 REPLY,回放跳过)。
//
// 防死循环:deferCount 存在条目 JSON 里(appendPending Lua 原子,无共享计数
// 竞态),超 TURN_GATE_DEFER_MAX_REPLAYS 次按旧语义丢弃。

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { appendPending } from '../turn/buffer.js';
import type { PendingEntry } from '../turn/types.js';

export const DEFER_MIN_DELAY_MS = 3_000;
export const DEFER_MAX_DELAY_MS = 600_000;

/**
 * 把被 defer 的消息重排到 retryAfterMs 后重评。
 * 返回 false = 重放预算耗尽,调用方按旧语义静默丢弃。
 */
export async function scheduleGateDeferReeval(args: {
  chatId: number;
  entry: PendingEntry;
  /** 本条消息已被 defer 的次数(来自 turnContext,首次为 0)。 */
  deferCount: number;
  retryAfterMs: number;
  reason: string;
}): Promise<boolean> {
  const e = env();
  if (args.deferCount >= e.TURN_GATE_DEFER_MAX_REPLAYS) {
    logger.info(
      { chatId: args.chatId, deferCount: args.deferCount, reason: args.reason },
      'gate defer budget exhausted, dropping',
    );
    return false;
  }

  const delayMs = Math.min(Math.max(args.retryAfterMs, DEFER_MIN_DELAY_MS), DEFER_MAX_DELAY_MS);
  await appendPending({
    ...args.entry,
    deferReplay: true,
    deferCount: args.deferCount + 1,
  });
  await scheduleTurn(args.chatId, {
    trigger: 'gate_defer',
    delayMsOverride: delayMs,
    // forceNew 必须:此刻 meta.scheduledJobId 指向**当前 active 回合**,复用
    // 分支只会 markDirty → 收尾立即重排(不带延迟)→ defer 语义失效。
    forceNew: true,
  });
  logger.info(
    { chatId: args.chatId, delayMs, deferCount: args.deferCount + 1, reason: args.reason },
    'gate defer → timed re-eval scheduled',
  );
  return true;
}
