import { describe, it, expect } from 'vitest';
import { validateAgencyAction } from '../../../src/agent/agency.js';

describe('agency action validation', () => {
  it('accepts a valid speak action and trims text', () => {
    const r = validateAgencyAction({ type: 'speak', text: '  真的假的，我去对一下  ', replyToMessageId: 42 });
    expect(r.ok).toBe(true);
    expect(r.action).toEqual({ type: 'speak', text: '真的假的，我去对一下', replyToMessageId: 42 });
  });

  it('rejects empty text, bad replyTo and unknown types', () => {
    expect(validateAgencyAction({ type: 'speak', text: '   ' }).ok).toBe(false);
    expect(validateAgencyAction({ type: 'ask', question: '在吗', replyToMessageId: -1 }).ok).toBe(false);
    expect(validateAgencyAction({ type: 'dance' }).ok).toBe(false);
    expect(validateAgencyAction(null).ok).toBe(false);
  });

  it('validates wait bounds and correct debt fields', () => {
    expect(validateAgencyAction({ type: 'wait', reason: '等对方说完', waitSec: 30 }).ok).toBe(true);
    expect(validateAgencyAction({ type: 'wait', reason: 'x', waitSec: 999_999 }).ok).toBe(false);
    expect(validateAgencyAction({ type: 'correct', debtId: 7, resolution: '已核实' }).ok).toBe(true);
    expect(validateAgencyAction({ type: 'correct', debtId: 0, resolution: 'x' }).ok).toBe(false);
  });

  it('supports bounded structured args for observe and rejects unsafe shapes', () => {
    const valid = validateAgencyAction({ type: 'observe', target: 'l2-read:memory.search', args: { query: '猫' } });
    expect(valid.ok).toBe(true);
    expect(valid.action).toEqual({ type: 'observe', target: 'l2-read:memory.search', args: { query: '猫' } });
    expect(validateAgencyAction({ type: 'observe', target: 'x', args: [] }).reason).toBe('observe:bad_args');
    expect(validateAgencyAction({ type: 'observe', target: 'x', args: { value: 'x'.repeat(4_001) } }).reason).toBe('observe:args_too_large');
  });
});
