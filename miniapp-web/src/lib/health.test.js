import { describe, expect, it } from 'vitest';
import { formatUptimeSeconds, formatHealthTimestamp } from './health';

describe('health helpers', () => {
  it('formats uptime in compact chinese units', () => {
    expect(formatUptimeSeconds(59)).toBe('59秒');
    expect(formatUptimeSeconds(3661)).toBe('1小时 1分');
    expect(formatUptimeSeconds(90061)).toBe('1天 1小时');
  });

  it('formats timestamps with month/day and time', () => {
    expect(formatHealthTimestamp(0)).toBe('未知');
    expect(formatHealthTimestamp(Date.UTC(2026, 3, 10, 17, 0))).toContain('04/');
  });
});
