// ────────────────────────────────────────
// Turn Actor — 在飞生成的打断注册表(进程内)
// ────────────────────────────────────────
//
// G3:新消息落地时打断同 chat 正在进行的 LLM 生成,带新上下文重规划。
// 单 worker 进程内 Map 即可(ingress 与 worker 同进程);若未来拆进程,
// 在 ingress 侧发布 Redis 频道 xxb:turn:abort:{chatId},worker 订阅后
// 调用本模块的 interruptGeneration —— 接口保持不变。
//
// 对应 MaiBot 语义:
//   - 仅 planner/writer 可被打断(timing gate 不注册到这里)
//   - 连续打断有上限(planner_interrupt_max_consecutive_count),超过后
//     放行当前生成,避免高频群把 bot 永久掐死
//   - 打断成功后调用方应等静默期(quiet-period.ts)再重规划

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

interface ActiveGeneration {
  controller: AbortController;
  epoch: number;
  startedAt: number;
}

const active = new Map<number, ActiveGeneration>();
/** 每 chat 连续打断计数;生成无打断走完即重置 */
const consecutiveInterrupts = new Map<number, number>();

/**
 * Register a new interruptible generation for this chat.
 * Returns the AbortController whose signal must be threaded into the AI calls.
 */
export function registerGeneration(chatId: number, epoch: number): AbortController {
  const controller = new AbortController();
  active.set(chatId, { controller, epoch, startedAt: Date.now() });
  return controller;
}

/**
 * Mark the generation finished. `interrupted=false` resets the consecutive
 * interrupt counter (MaiBot resets on a clean completion).
 */
export function clearGeneration(chatId: number, controller: AbortController, interrupted: boolean): void {
  const current = active.get(chatId);
  if (current && current.controller === controller) {
    active.delete(chatId);
  }
  if (!interrupted) {
    consecutiveInterrupts.delete(chatId);
  }
}

/** True when this chat currently has an interruptible generation in flight. */
export function hasActiveGeneration(chatId: number): boolean {
  return active.has(chatId);
}

/**
 * Interrupt the chat's in-flight generation (if any).
 * Respects TURN_INTERRUPT_MAX_CONSECUTIVE: beyond the cap the current
 * generation is allowed to finish (returns false).
 */
export function interruptGeneration(chatId: number, reason: string): boolean {
  if (!env().TURN_ABORT_ENABLED) return false;
  const current = active.get(chatId);
  if (!current) return false;
  if (current.controller.signal.aborted) return false;

  const count = consecutiveInterrupts.get(chatId) ?? 0;
  const max = env().TURN_INTERRUPT_MAX_CONSECUTIVE;
  if (count >= max) {
    logger.debug({ chatId, count, max }, 'Interrupt cap reached, letting generation finish');
    return false;
  }

  consecutiveInterrupts.set(chatId, count + 1);
  current.controller.abort(new Error(`turn_interrupt: ${reason}`));
  logger.info(
    { chatId, reason, epoch: current.epoch, inFlightMs: Date.now() - current.startedAt, consecutive: count + 1 },
    'In-flight generation interrupted by new message',
  );
  return true;
}

/** Test helper. */
export function _resetAbortRegistry(): void {
  active.clear();
  consecutiveInterrupts.clear();
}
