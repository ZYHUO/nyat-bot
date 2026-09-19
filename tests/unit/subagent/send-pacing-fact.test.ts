import { describe, expect, it } from 'vitest';
import { buildPacingAckSuffix } from '../../../src/subagent/host-api.js';

// 2026-09-19 production incident: one「猫猫」summon at ~2am produced 6 near-identical
// sleepy greetings in a single CodeAct task (the model kept re-phrasing out loud and
// every variant went out as a real message). The physical maxTextSends cap was 6 and
// the model used all 6. Per the self-regulation design, the host reports the FACT
// (gap since your last send) in the sendText ack and the persona decides — no
// blocking, no wasted heart call.

describe('buildPacingAckSuffix', () => {
  it('adds no note on the first send of a task (gap unknown)', () => {
    expect(buildPacingAckSuffix(null)).toBe('');
  });

  it('adds no note when the gap is comfortable (>= 90s)', () => {
    expect(buildPacingAckSuffix(90)).toBe('');
    expect(buildPacingAckSuffix(300)).toBe('');
  });

  it('reports the fact on rapid follow-up sends', () => {
    const suffix = buildPacingAckSuffix(5);
    expect(suffix).toContain('5 秒');
    // The note must read as a felt fact, not a quota or a hard block.
    expect(suffix).not.toContain('禁止');
    expect(suffix).not.toContain('错误');
    expect(suffix).not.toContain('失败');
  });

  it('fires for every sub-90s gap, however small', () => {
    expect(buildPacingAckSuffix(1)).toContain('1 秒');
    expect(buildPacingAckSuffix(45)).toContain('45 秒');
    expect(buildPacingAckSuffix(89)).toContain('89 秒');
  });
});
