import { describe, expect, it } from 'vitest';
import { beijingHour, dayPeriod, formatBeijingNowLine } from '../../../src/shared/beijing-time.js';

describe('beijing-time', () => {
  it('maps UTC morning to Beijing afternoon/evening when offset +8', () => {
    // 2026-07-22 09:00 UTC = 17:00 北京
    const utcMorning = new Date('2026-07-22T09:00:00.000Z');
    expect(beijingHour(utcMorning)).toBe(17);
    expect(dayPeriod(17)).toBe('下午');
    expect(formatBeijingNowLine(utcMorning)).toMatch(/北京时间 UTC\+8，现在是下午/);
  });

  it('maps late UTC to Beijing late night / early morning', () => {
    // 2026-07-22 18:30 UTC = 次日 02:30 北京
    const d = new Date('2026-07-22T18:30:00.000Z');
    expect(beijingHour(d)).toBe(2);
    expect(dayPeriod(2)).toBe('凌晨');
  });

  it('never exposes Zulu ISO as the primary clock', () => {
    const line = formatBeijingNowLine(new Date('2026-07-22T01:00:00.000Z')); // 09:00 BJ
    expect(line).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(line).toMatch(/现在是上午/);
  });
});
