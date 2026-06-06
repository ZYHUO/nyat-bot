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
  _resetAbortRegistry,
} from '../../../src/pipeline/turn/abort-registry.js';

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
