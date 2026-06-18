import { describe, it, expect } from 'vitest';
import { assembleBurstHint, KEEP_ALWAYS, type CtxPart } from '../../../src/pipeline/reply/burst-hint.js';

describe('assembleBurstHint', () => {
  it('renders by order (text position), not by keep (importance)', () => {
    // 念头 is the MOST important (keep=2, must-keep) but must render LAST (order=99,
    // closest to CURRENT_MESSAGE). 此刻的你 (order=50) sits before it.
    const parts: CtxPart[] = [
      { order: 99, keep: 2, text: '[你的念头] ...' },
      { order: 50, keep: 20, text: '[此刻的你] ...' },
      { order: 14, keep: 10, text: '[本群黑话] ...' },
    ];
    const out = assembleBurstHint(parts, 1400)!;
    const iJargon = out.indexOf('[本群黑话]');
    const iSelf = out.indexOf('[此刻的你]');
    const iHeart = out.indexOf('[你的念头]');
    expect(iJargon).toBeLessThan(iSelf);
    expect(iSelf).toBeLessThan(iHeart);
    // heart is the final block — the writer opens from it
    expect(out.endsWith('[你的念头] ...')).toBe(true);
  });

  it('regression: heart (keep=2) is no longer dragged to the front of the block', () => {
    const parts: CtxPart[] = [
      { order: 99, keep: 2, text: 'HEART' },
      { order: 10, keep: 50, text: 'AMBIENCE' },
    ];
    const out = assembleBurstHint(parts, 1400)!;
    // Old single-priority sort put keep=2 first; now ambience(order=10) leads.
    expect(out.indexOf('AMBIENCE')).toBeLessThan(out.indexOf('HEART'));
  });

  it('drops low-importance (high keep) parts first under budget pressure', () => {
    const big = 'x'.repeat(100);
    const parts: CtxPart[] = [
      { order: 10, keep: 45, text: `LOW ${big}` },   // least important — evicted
      { order: 20, keep: 15, text: `MID ${big}` },   // survives
      { order: 30, keep: 12, text: `HIGH ${big}` },  // survives
    ];
    // budget fits ~2 of the 3 (each ~104 chars)
    const out = assembleBurstHint(parts, 220)!;
    expect(out).toContain('HIGH');
    expect(out).toContain('MID');
    expect(out).not.toContain('LOW');
  });

  it('never drops must-keep parts (keep < KEEP_ALWAYS) even over budget', () => {
    const big = 'y'.repeat(500);
    const parts: CtxPart[] = [
      { order: 99, keep: 2, text: `HEART ${big}` },        // must-keep
      { order: 80, keep: 1, text: `INSTRUCTION ${big}` },  // must-keep
      { order: 10, keep: 30, text: `AMBIENCE ${big}` },    // evictable
    ];
    const out = assembleBurstHint(parts, 100)!; // far below total
    expect(out).toContain('HEART');
    expect(out).toContain('INSTRUCTION');
    expect(out).not.toContain('AMBIENCE');
    // must-keeps still rendered in order: INSTRUCTION(80) before HEART(99)
    expect(out.indexOf('INSTRUCTION')).toBeLessThan(out.indexOf('HEART'));
  });

  it('returns undefined when there are no parts', () => {
    expect(assembleBurstHint([], 1400)).toBeUndefined();
  });

  it('KEEP_ALWAYS threshold is the documented value', () => {
    expect(KEEP_ALWAYS).toBe(10);
  });
});
