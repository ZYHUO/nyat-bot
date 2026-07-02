import { describe, it, expect, vi } from 'vitest';

// parseState 是纯函数,但 state-store.ts 顶层 import 了 redis/env/logger,
// 为避免任何导入期副作用,按 gate-fallback.test.ts 的模式 mock 掉。

vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../../src/env.js', () => ({
  env: () => ({ TIMING_STATE_TTL_SEC: 86400 }),
}));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { _internal } from '../../../../src/pipeline/timing/state-store.js';

const { parseState } = _internal;

describe('parseState waitTriggerUids (per-person WAIT 抑制集合, L1)', () => {
  it('parses comma-separated uid list → number[]', () => {
    const s = parseState({ state: 'WAIT', waitTriggerUids: '7,42', waitUntil: '9999' });
    expect(s.state).toBe('WAIT');
    expect(s.waitTriggerUids).toEqual([7, 42]);
  });

  it('single uid → single-element array', () => {
    const s = parseState({ state: 'WAIT', waitTriggerUids: '42' });
    expect(s.waitTriggerUids).toEqual([42]);
  });

  it('omits waitTriggerUids when absent', () => {
    const s = parseState({ state: 'RUNNING' });
    expect(s.waitTriggerUids).toBeUndefined();
  });

  it('ignores non-numeric segments (keeps the rest)', () => {
    const s = parseState({ state: 'WAIT', waitTriggerUids: '7,abc,42' });
    expect(s.waitTriggerUids).toEqual([7, 42]);
  });

  it('all-non-numeric → empty array', () => {
    const s = parseState({ state: 'WAIT', waitTriggerUids: 'abc,xyz' });
    expect(s.waitTriggerUids).toEqual([]);
  });

  it('preserves other fields alongside waitTriggerUids', () => {
    const s = parseState({
      state: 'WAIT',
      waitTriggerUids: '7',
      waitUntil: '100',
      waitAnchorMid: '55',
      noActionCount: '3',
      lastGateAction: 'wait',
    });
    expect(s.waitTriggerUids).toEqual([7]);
    expect(s.waitUntil).toBe(100);
    expect(s.waitAnchorMid).toBe(55);
    expect(s.noActionCount).toBe(3);
    expect(s.lastGateAction).toBe('wait');
  });
});
