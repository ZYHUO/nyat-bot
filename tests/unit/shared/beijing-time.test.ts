import { describe, expect, it } from 'vitest';
import { beijingHour, dayPeriod, festivalHint, formatBeijingNowLine } from '../../../src/shared/beijing-time.js';

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

describe('festivalHint（节日环境感知）', () => {
  it('2026-08-19 是七夕（实证日期）', () => {
    // 北京时间 8/19 晚 = UTC 8/19 中午
    expect(festivalHint(new Date('2026-08-19T12:00:00.000Z'))).toContain('今天是七夕');
  });

  it('节日前一晚给「明天是」预告', () => {
    expect(festivalHint(new Date('2026-08-18T12:00:00.000Z'))).toBe('明天是七夕');
  });

  it('2026 春节/中秋/端午查表正确', () => {
    expect(festivalHint(new Date('2026-02-17T04:00:00.000Z'))).toContain('春节');
    expect(festivalHint(new Date('2026-09-25T04:00:00.000Z'))).toContain('中秋节');
    expect(festivalHint(new Date('2026-06-19T04:00:00.000Z'))).toContain('端午节');
  });

  it('公历节日：2/14 情人节、12/31 跨年夜', () => {
    expect(festivalHint(new Date('2026-02-14T04:00:00.000Z'))).toContain('情人节');
    expect(festivalHint(new Date('2026-12-31T04:00:00.000Z'))).toContain('跨年夜');
  });

  it('普通日子返回 null', () => {
    expect(festivalHint(new Date('2026-08-21T04:00:00.000Z'))).toBeNull();
  });

  it('表外年份（2029）不误报农历节日', () => {
    expect(festivalHint(new Date('2029-08-19T12:00:00.000Z'))).toBeNull();
  });

  it('formatBeijingNowLine 整合节日提示', () => {
    expect(formatBeijingNowLine(new Date('2026-08-19T12:00:00.000Z'))).toMatch(/今天是七夕/);
  });
});
