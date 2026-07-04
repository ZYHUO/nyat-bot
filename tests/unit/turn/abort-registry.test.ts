import { describe, it, expect, beforeEach, vi } from 'vitest';

const envState = {
  TURN_ABORT_ENABLED: true,
  TURN_INTERRUPT_MAX_CONSECUTIVE: 1,
};

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  registerGeneration,
  registerWeakGeneration,
  clearGeneration,
  hasActiveGeneration,
  interruptGeneration,
  abortAllGenerations,
  isShuttingDown,
  getShutdownSignal,
  _resetAbortRegistry,
} from '../../../src/pipeline/turn/abort-registry.js';
import { isCallerAbort } from '../../../src/shared/abort.js';

const CHAT = -100600;

beforeEach(() => {
  _resetAbortRegistry();
  envState.TURN_ABORT_ENABLED = true;
  envState.TURN_INTERRUPT_MAX_CONSECUTIVE = 1;
});

describe('abort registry', () => {
  it('interrupts an active generation and aborts its signal', () => {
    const controller = registerGeneration(CHAT, 1);
    expect(hasActiveGeneration(CHAT)).toBe(true);

    const interrupted = interruptGeneration(CHAT, 'new_message');
    expect(interrupted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('is a no-op when TURN_ABORT_ENABLED=false', () => {
    envState.TURN_ABORT_ENABLED = false;
    const controller = registerGeneration(CHAT, 1);
    expect(interruptGeneration(CHAT, 'new_message')).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it('is a no-op when no generation is in flight', () => {
    expect(interruptGeneration(CHAT, 'new_message')).toBe(false);
  });

  it('enforces the consecutive interrupt cap (MaiBot semantics)', () => {
    // 1st generation interrupted (cap=1)
    const c1 = registerGeneration(CHAT, 1);
    expect(interruptGeneration(CHAT, 'msg')).toBe(true);
    clearGeneration(CHAT, c1, true);

    // Retry generation: cap reached → must be allowed to finish
    const c2 = registerGeneration(CHAT, 1);
    expect(interruptGeneration(CHAT, 'msg')).toBe(false);
    expect(c2.signal.aborted).toBe(false);
    clearGeneration(CHAT, c2, false); // clean completion resets counter

    // Counter reset → interruptible again
    const c3 = registerGeneration(CHAT, 2);
    expect(interruptGeneration(CHAT, 'msg')).toBe(true);
    expect(c3.signal.aborted).toBe(true);
  });

  it('does not double-abort the same generation', () => {
    envState.TURN_INTERRUPT_MAX_CONSECUTIVE = 5;
    registerGeneration(CHAT, 1);
    expect(interruptGeneration(CHAT, 'a')).toBe(true);
    expect(interruptGeneration(CHAT, 'b')).toBe(false); // already aborted
  });

  it('clearGeneration only removes the matching controller', () => {
    const stale = registerGeneration(CHAT, 1);
    const fresh = registerGeneration(CHAT, 2); // supersedes in map
    clearGeneration(CHAT, stale, false); // stale clear → ignored
    expect(hasActiveGeneration(CHAT)).toBe(true);
    clearGeneration(CHAT, fresh, false);
    expect(hasActiveGeneration(CHAT)).toBe(false);
  });

  it('registerGeneration supersedes: aborts the prior in-flight generation with a TurnInterrupt reason', () => {
    const prior = registerGeneration(CHAT, 1);
    registerGeneration(CHAT, 2);
    expect(prior.signal.aborted).toBe(true);
    expect((prior.signal.reason as Error).name).toBe('TurnInterrupt');
  });

  it('weak registration yields to an active generation — never preempts a real reply', () => {
    const real = registerGeneration(CHAT, 5);
    const weak = registerWeakGeneration(CHAT, 0);
    expect(weak).toBeNull();
    expect(real.signal.aborted).toBe(false); // 真回复毫发无损

    clearGeneration(CHAT, real, false);
    const weak2 = registerWeakGeneration(CHAT, 0);
    expect(weak2).toBeInstanceOf(AbortController);
  });

  it('a superseded stale flow cannot reset the new generation interrupt budget', () => {
    envState.TURN_INTERRUPT_MAX_CONSECUTIVE = 1;
    const old = registerGeneration(CHAT, 1);
    expect(interruptGeneration(CHAT, 'msg')).toBe(true); // 消耗预算 → count=1

    const fresh = registerGeneration(CHAT, 2); // supersede old(已 abort)
    // 旧 flow 在自己的 finally 里收尾 —— 不许重置新一代的预算
    clearGeneration(CHAT, old, false);
    expect(interruptGeneration(CHAT, 'msg2')).toBe(false); // cap 仍然生效
    expect(fresh.signal.aborted).toBe(false);
  });

  it('interrupt abort reason is tagged TurnInterrupt (isCallerAbort allowlist)', () => {
    const c = registerGeneration(CHAT, 1);
    interruptGeneration(CHAT, 'new_message');
    expect((c.signal.reason as Error).name).toBe('TurnInterrupt');
  });
});

describe('shutdown broadcast (关机契约)', () => {
  it('abortAllGenerations 中止全部在飞生成,reason=Shutdown(isCallerAbort 白名单生效)', () => {
    const a = registerGeneration(-1, 1);
    const b = registerGeneration(-2, 1);
    expect(isShuttingDown()).toBe(false);

    abortAllGenerations();

    expect(isShuttingDown()).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect((a.signal.reason as Error).name).toBe('Shutdown');
    expect(isCallerAbort(a.signal)).toBe(true);
    expect(getShutdownSignal().aborted).toBe(true);
  });

  it('广播后迟到的注册:register 拿到预中止 controller,weak 直接 null', () => {
    abortAllGenerations();
    const late = registerGeneration(-3, 1);
    expect(late.signal.aborted).toBe(true);
    expect((late.signal.reason as Error).name).toBe('Shutdown');
    expect(hasActiveGeneration(-3)).toBe(false); // 不进 active(没有生成好清)
    expect(registerWeakGeneration(-3, 1)).toBeNull();
  });

  it('_resetAbortRegistry 复位关机状态(测试间隔离)', () => {
    abortAllGenerations();
    _resetAbortRegistry();
    expect(isShuttingDown()).toBe(false);
    expect(getShutdownSignal().aborted).toBe(false);
    expect(registerGeneration(-4, 1).signal.aborted).toBe(false);
  });
});
