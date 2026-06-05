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
    const fresh = registerGeneration(CHAT, 2); // replaces in map
    clearGeneration(CHAT, stale, false); // stale clear → ignored
    expect(hasActiveGeneration(CHAT)).toBe(true);
    clearGeneration(CHAT, fresh, false);
    expect(hasActiveGeneration(CHAT)).toBe(false);
  });
});
