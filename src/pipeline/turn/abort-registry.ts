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

import { setMaxListeners } from 'node:events';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

interface ActiveGeneration {
  controller: AbortController;
  epoch: number;
  startedAt: number;
}

interface InterruptStat {
  count: number;
  firstAt: number;
  lastAt: number;
  reasons: Record<string, number>;
}

const active = new Map<number, ActiveGeneration>();
/** 每 chat 连续打断计数;生成无打断走完即重置 */
const consecutiveInterrupts = new Map<number, number>();
const interruptStats = new Map<number, InterruptStat>();

// ── 关机契约(2026-07-04):主回合生成的 Shutdown 广播 ──
// 此前只有 self-continue 有关机信号,主回合生成没人 abort → closeWorker
// 无限期等在飞 chat_turn(LLM+humanizer 睡眠可跑数分钟)→ 30s 强杀。
let shuttingDown = false;
let shutdownController = makeShutdownController();

function makeShutdownController(): AbortController {
  const c = new AbortController();
  // 共享信号被 deliver 的每个 sleepWithAbort 挂/摘监听,并发高时会撞
  // Node 默认 10 listener 上限的误告警 —— 放开(0 = 不限)。
  try { setMaxListeners(0, c.signal); } catch { /* 非关键 */ }
  return c;
}

function shutdownError(): Error {
  return Object.assign(new Error('shutdown'), { name: 'Shutdown' });
}

/** index.ts shutdown() 调:中止全部在飞生成,此后新注册直接拿到已中止信号。 */
export function abortAllGenerations(): void {
  shuttingDown = true;
  if (!shutdownController.signal.aborted) shutdownController.abort(shutdownError());
  for (const [chatId, gen] of active) {
    if (!gen.controller.signal.aborted) {
      gen.controller.abort(shutdownError());
      logger.info({ chatId, epoch: gen.epoch }, 'In-flight generation aborted for shutdown');
    }
  }
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** deliver 等长睡眠路径挂这个信号 —— 关机广播能叫醒它们。 */
export function getShutdownSignal(): AbortSignal {
  return shutdownController.signal;
}

function noteInterrupt(chatId: number, reason: string): InterruptStat {
  const now = Date.now();
  const stat = interruptStats.get(chatId) ?? { count: 0, firstAt: now, lastAt: now, reasons: {} };
  stat.count++;
  stat.lastAt = now;
  stat.reasons[reason] = (stat.reasons[reason] ?? 0) + 1;
  interruptStats.set(chatId, stat);
  return stat;
}

function flushInterruptSummary(chatId: number): void {
  const stat = interruptStats.get(chatId);
  if (!stat || stat.count === 0) return;
  logger.info(
    {
      chatId,
      interrupts: stat.count,
      windowMs: stat.lastAt - stat.firstAt,
      reasons: stat.reasons,
    },
    'In-flight generation interrupt summary',
  );
  interruptStats.delete(chatId);
}

/** Caller-intent abort error — isCallerAbort() 白名单识别这个 name。 */
function turnInterruptError(reason: string): Error {
  const err = new Error(`turn_interrupt: ${reason}`);
  err.name = 'TurnInterrupt';
  return err;
}

/**
 * Register a new interruptible generation for this chat.
 * Returns the AbortController whose signal must be threaded into the AI calls.
 * 若该 chat 已有在飞生成(典型:self-continue 还没结束,新回合开始了),
 * 直接掐掉旧的 —— 真回复永远优先于跟拍(codex review #2)。
 */
export function registerGeneration(chatId: number, epoch: number): AbortController {
  if (shuttingDown) {
    // 广播之后迟到的注册:第一跳就中止,不进 active(没有生成好清)。
    const controller = new AbortController();
    controller.abort(shutdownError());
    return controller;
  }
  const prior = active.get(chatId);
  if (prior && !prior.controller.signal.aborted) {
    prior.controller.abort(turnInterruptError('superseded by newer generation'));
    // info 级:TURN_EXEC_LOCK 上线后 supersede 应归零(双回合互杀的直接证据,
    // debug 级曾让这个竞态在生产隐形了两周)。再现 = 锁失效告警。
    logger.info({ chatId, priorEpoch: prior.epoch }, 'Prior in-flight generation superseded');
  }
  const controller = new AbortController();
  active.set(chatId, { controller, epoch, startedAt: Date.now() });
  return controller;
}

/**
 * 弱注册(self-continue 等低优先级生成专用):已有在飞生成时返回 null,
 * **绝不**抢占 —— 否则上一回合的跟拍会掐死下一回合的真回复(优先级
 * 倒挂,review-workflow P1)。
 */
export function registerWeakGeneration(chatId: number, epoch: number): AbortController | null {
  if (shuttingDown) return null; // 关机中不再起跟拍
  const prior = active.get(chatId);
  if (prior && !prior.controller.signal.aborted) {
    logger.debug({ chatId }, 'Weak generation yielded to active generation');
    return null;
  }
  const controller = new AbortController();
  active.set(chatId, { controller, epoch, startedAt: Date.now() });
  return controller;
}

/**
 * Mark the generation finished. `interrupted=false` resets the consecutive
 * interrupt counter (MaiBot resets on a clean completion)。
 * 计数器重置带身份守卫:被 supersede 的旧 flow 在收尾时不许动新一代的
 * 打断预算(review-workflow:counter corruption)。
 */
export function clearGeneration(chatId: number, controller: AbortController, interrupted: boolean): void {
  const current = active.get(chatId);
  const isCurrent = current?.controller === controller;
  if (isCurrent) {
    active.delete(chatId);
  }
  if (!interrupted && isCurrent) {
    consecutiveInterrupts.delete(chatId);
    flushInterruptSummary(chatId);
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
  const stat = noteInterrupt(chatId, reason);
  current.controller.abort(turnInterruptError(reason));
  if (stat.count === 1) {
    logger.debug(
      { chatId, reason, epoch: current.epoch, inFlightMs: Date.now() - current.startedAt, consecutive: count + 1 },
      'In-flight generation interrupted by new message',
    );
  }
  return true;
}

/** Test helper. */
export function _resetAbortRegistry(): void {
  active.clear();
  consecutiveInterrupts.clear();
  interruptStats.clear();
  shuttingDown = false;
  shutdownController = makeShutdownController();
}
