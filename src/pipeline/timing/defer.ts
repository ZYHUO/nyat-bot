// ────────────────────────────────────────
// P0-B: gate defer = 延迟重评(MaiBot delayed-task 语义)
// ────────────────────────────────────────
//
// MaiBot 在退避/未达阈值时不丢消息:挂 delayed task 到点带着 pending 消息
// 重新走完整评估(runtime.py:1096-1101/1494-1504)。
//
// 设计(review finding #1 后重做,对齐 wait-resume 的"载荷即暂存"):
//   被 defer 的条目存进**专用延迟 job 的载荷**,而不是立刻 append 回
//   pending —— 否则回合收尾的 stillPending>0 自我重排会在 ~2s 后提前
//   drain 它(冷却/阈值仍未满足 → 烧光重放预算 → 消息照旧丢),且
//   scheduleTurn(forceNew) 会覆写 meta.scheduledJobId 留下孤儿延迟回合。
//   到点后 worker 调 handleDeferResume:重注入 pending + 排即时回合。
//
// 防死循环:deferCount 存在条目 JSON 里,超 TURN_GATE_DEFER_MAX_REPLAYS 次
// 时调用方(gate/心流短路层)不再 defer,直接放行给 LLM 裁决 —— 预算耗尽
// 的兜底是"多烧一次 LLM",不是丢消息。

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { enqueueDeferResume } from '../../queue/producer.js';
import { scheduleTurn } from '../../queue/turn-scheduler.js';
import { reinjectDeferEntries } from '../turn/buffer.js';
import type { PendingEntry } from '../turn/types.js';

export const DEFER_MIN_DELAY_MS = 3_000;
export const DEFER_MAX_DELAY_MS = 600_000;

/** 调用方短路层用:该条目是否还有 defer 预算(没有 → 放行给 LLM)。 */
export function hasDeferBudget(deferCount: number | undefined): boolean {
  return (deferCount ?? 0) < env().TURN_GATE_DEFER_MAX_REPLAYS;
}

/**
 * 把被 defer 的消息暂存进延迟 job,到点重评。
 * 返回 false = 重放预算耗尽(调用方应放行给 LLM,而不是丢弃)。
 */
export async function scheduleGateDeferReeval(args: {
  chatId: number;
  entry: PendingEntry;
  /** 本条消息已被 defer 的次数(来自 turnContext,首次为 0)。 */
  deferCount: number;
  retryAfterMs: number;
  reason: string;
}): Promise<boolean> {
  if (!hasDeferBudget(args.deferCount)) {
    logger.info(
      { chatId: args.chatId, deferCount: args.deferCount, reason: args.reason },
      'gate defer budget exhausted (caller should fall through to LLM)',
    );
    return false;
  }

  const delayMs = Math.min(Math.max(args.retryAfterMs, DEFER_MIN_DELAY_MS), DEFER_MAX_DELAY_MS);
  await enqueueDeferResume(args.chatId, delayMs, [
    { ...args.entry, deferReplay: true, deferCount: args.deferCount + 1 },
  ]);
  logger.info(
    { chatId: args.chatId, delayMs, deferCount: args.deferCount + 1, reason: args.reason },
    'gate defer → timed re-eval scheduled',
  );
  return true;
}

/**
 * defer-resume job 到点(worker 调):把暂存条目重注入 pending 并排即时
 * 回合。**不** forceNew:若此刻恰有 active 回合,markDirty 由其收尾重排
 * (条目已在 pending,不会丢);若有 delayed 回合,changeDelay 提前到现在。
 *
 * review R3#1:重注入走 reinjectDeferEntries(dedupToken)——BullMQ attempts:5
 * 重试同一 job 时,令牌门控保证 exactly-once 注入(append 成功、scheduleTurn
 * 失败的重试不会二次 RPUSH → 不重复回复)。scheduleTurn 幂等(forceNew 未设,
 * 复用/changeDelay),重试重排无害。dedupToken 用 job.id(每个 defer job 唯一)。
 */
export async function handleDeferResume(args: {
  chatId: number;
  dedupToken: string;
  deferResume?: { scheduledAt: number; entries: PendingEntry[] };
}): Promise<void> {
  const entries = args.deferResume?.entries ?? [];
  if (entries.length === 0) return;
  const injected = await reinjectDeferEntries(args.chatId, args.dedupToken, entries);
  // scheduleTurn 失败必须抛出让 BullMQ 重试:吞掉的话条目已注入 pending 却永远
  // 没有回合去 drain(直到下一条消息碰巧触发)。重试时 dedupToken 保证不重复注入。
  try {
    await scheduleTurn(args.chatId, { trigger: 'gate_defer', delayMsOverride: 0 });
  } catch (err) {
    logger.warn(
      { err, chatId: args.chatId, entryCount: entries.length, dedupToken: args.dedupToken },
      'defer-resume: entries injected but scheduleTurn failed — rethrowing for retry',
    );
    throw err;
  }
  logger.info(
    { chatId: args.chatId, entryCount: entries.length, injected, dedupToken: args.dedupToken },
    injected === -1
      ? 'defer-resume retry: entries already injected (dedup), turn re-scheduled'
      : 'defer-resume fired → entries re-injected, gate_defer turn scheduled',
  );
}
