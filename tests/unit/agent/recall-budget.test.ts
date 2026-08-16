import { describe, it, expect } from 'vitest';
import { applyRecallBudget, placeInGoldenZone, budgetStatus } from '../../../src/agent/recall-budget.js';

describe('applyRecallBudget', () => {
  it('sorts by signal desc and truncates to budget', () => {
    const items = [
      { id: 1, content: 'a', signal: 0.5 },
      { id: 2, content: 'b', signal: 1 },
      { id: 3, content: 'c', signal: 0 },
      { id: 4, content: 'd', signal: 0.8 },
    ];
    const r = applyRecallBudget(items, 2);
    expect(r.map((i) => i.id)).toEqual([2, 4]); // 最高信号在前
  });

  it('defaults signal to 0.5 when missing', () => {
    const items = [
      { id: 1, content: 'a' },
      { id: 2, content: 'b', signal: 1 },
    ];
    const r = applyRecallBudget(items, 2);
    expect(r[0]!.id).toBe(2);
  });

  it('empty or zero budget returns empty', () => {
    expect(applyRecallBudget([], 3)).toEqual([]);
    expect(applyRecallBudget([{ id: 1, content: 'a' }], 0)).toEqual([]);
  });

  it('stable sort: equal signals keep original order', () => {
    const items = [
      { id: 1, content: 'a', signal: 0.5 },
      { id: 2, content: 'b', signal: 0.5 },
    ];
    expect(applyRecallBudget(items, 2).map((i) => i.id)).toEqual([1, 2]);
  });
});

describe('placeInGoldenZone', () => {
  it('prepends block when prompt has no experience block', () => {
    const out = placeInGoldenZone('执行指令', '[高信号]');
    expect(out).toBe('[高信号]\n\n执行指令');
  });

  it('appends into existing [过往经验] block', () => {
    const out = placeInGoldenZone('...[过往经验]\n- a', '[高信号]');
    expect(out).toContain('[过往经验]\n[高信号]\n- a');
  });

  it('empty block returns prompt unchanged', () => {
    expect(placeInGoldenZone('p', '')).toBe('p');
  });
});

describe('budgetStatus', () => {
  it('reports over-budget blocks', () => {
    const s = budgetStatus([
      { name: '经验', items: 5, max: 3 },
      { name: '记忆', items: 2, max: 4 },
    ]);
    expect(s.over).toBe(true);
    expect(s.lines[0]).toContain('⚠️超限');
    expect(s.lines[1]).not.toContain('⚠️');
  });
});
