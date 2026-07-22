import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.fn(() => ({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'school' as const }));
vi.mock('../../../src/env.js', () => ({ env: () => mockEnv() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// no school_overrides row → getDb().prepare().get() returns undefined path; mock to throw → treated as no override
vi.mock('../../../src/db/sqlite.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}));

import { getSchoolState, getSchoolAttentionFactor, getDaySummary } from '../../../src/tracking/school-state.js';

// helper: build a Date that is the given Beijing weekday + HH:MM.
// 2026-06-15 is a Monday (UTC). We pick UTC times and add nothing — getSchoolState
// converts to Beijing by +8h, so we pass UTC = Beijing-8h.
function bjDate(isoBeijing: string): Date {
  // isoBeijing like '2026-06-15T08:10' (Beijing). Convert to UTC by -8h.
  const asUtc = new Date(isoBeijing + ':00Z');
  return new Date(asUtc.getTime() - 8 * 3600_000);
}

describe('getSchoolState', () => {
  beforeEach(() => {
    mockEnv.mockReturnValue({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'school' });
  });

  it('returns free no-op when disabled', () => {
    mockEnv.mockReturnValue({ SCHOOL_SCHEDULE_ENABLED: false, DAILY_LIFE_PROFILE: 'school' });
    const s = getSchoolState(bjDate('2026-06-15T08:10'));
    expect(s.phase).toBe('free');
    expect(s.selfLine).toBeNull();
  });

  it('weekday during first period → in_class with a subject and low attention', () => {
    // Monday 08:10 → 第1节 (08:00-08:45)
    const s = getSchoolState(bjDate('2026-06-15T08:10'));
    expect(s.isSchoolDay).toBe(true);
    expect(s.phase).toBe('in_class');
    expect(s.currentSubject).toBe('语文'); // Monday slot 0
    expect(s.attentionFactor).toBeLessThanOrEqual(0.3);
    expect(s.selfLine).toContain('上语文课');
  });

  it('weekday between periods → break', () => {
    // Monday 08:48 → between 第1节(…08:45) and 第2节(08:55…)
    const s = getSchoolState(bjDate('2026-06-15T08:48'));
    expect(s.phase).toBe('break');
    expect(s.selfLine).toContain('课间');
  });

  it('weekday lunch window → lunch, selfLine null (life-state eating covers)', () => {
    const s = getSchoolState(bjDate('2026-06-15T12:30'));
    expect(s.phase).toBe('lunch');
    expect(s.selfLine).toBeNull();
  });

  it('weekday after 16:35 before evening → after_school, full attention', () => {
    const s = getSchoolState(bjDate('2026-06-15T17:30'));
    expect(s.phase).toBe('after_school');
    expect(s.attentionFactor).toBe(1);
    expect(s.selfLine).toContain('放学');
  });

  it('weekday evening study window → evening_study', () => {
    const s = getSchoolState(bjDate('2026-06-15T20:00'));
    expect(s.phase).toBe('evening_study');
    expect(s.selfLine).toContain('晚自习');
  });

  it('weekend → rest-day plan (not school), with a daily activity line', () => {
    // 2026-06-13 is Saturday
    const s = getSchoolState(bjDate('2026-06-13T10:00'));
    expect(s.isSchoolDay).toBe(false);
    expect(s.profile).toBe('weekend');
    expect(s.activity).toBeTruthy();
    expect(s.selfLine).toMatch(/周末/);
  });

  it('summer profile mid-morning → day_plan gaming, not in_class', () => {
    mockEnv.mockReturnValue({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'summer' });
    const s = getSchoolState(bjDate('2026-07-22T10:30'));
    expect(s.isSchoolDay).toBe(false);
    expect(s.profile).toBe('summer');
    expect(s.phase).toBe('day_plan');
    expect(s.activity).toMatch(/游戏|追番/);
    expect(s.selfLine).toMatch(/暑假/);
  });

  it('auto profile in July → summer even on weekday morning', () => {
    mockEnv.mockReturnValue({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'auto' });
    // 2026-07-22 is Wednesday
    const s = getSchoolState(bjDate('2026-07-22T08:10'));
    expect(s.isSchoolDay).toBe(false);
    expect(s.profile).toBe('summer');
    expect(s.phase).not.toBe('in_class');
  });

  it('late night after evening study → free', () => {
    const s = getSchoolState(bjDate('2026-06-15T22:30'));
    expect(s.phase).toBe('free');
  });

  it('A2: getSchoolAttentionFactor low in class, 1 after school', () => {
    expect(getSchoolAttentionFactor(bjDate('2026-06-15T08:10'))).toBeLessThanOrEqual(0.3); // in class
    expect(getSchoolAttentionFactor(bjDate('2026-06-15T17:30'))).toBe(1); // after school
    expect(getSchoolAttentionFactor(bjDate('2026-06-13T10:00'))).toBe(1); // weekend play
  });

  it('A3: getDaySummary describes weekday classes / weekend without inventing times', () => {
    const wd = getDaySummary(bjDate('2026-06-15T08:10'));
    expect(wd?.isSchoolDay).toBe(true);
    expect(wd?.text).toContain('工作日');
    expect(wd?.text).toContain('语文'); // Monday subjects
    const we = getDaySummary(bjDate('2026-06-13T10:00'));
    expect(we?.isSchoolDay).toBe(false);
    expect(we?.text).toContain('周末');
  });

  it('A2/A3 disabled → factor 1, summary null', () => {
    mockEnv.mockReturnValue({ SCHOOL_SCHEDULE_ENABLED: false, DAILY_LIFE_PROFILE: 'school' });
    expect(getSchoolAttentionFactor(bjDate('2026-06-15T08:10'))).toBe(1);
    expect(getDaySummary(bjDate('2026-06-15T08:10'))).toBeNull();
  });
});

describe('getSchoolState with overrides', () => {
  it('early_off override → after the cutoff is after_school, not in_class (review #3)', async () => {
    vi.resetModules();
    vi.doMock('../../../src/env.js', () => ({
      env: () => ({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'school' }),
    }));
    vi.doMock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn() } }));
    vi.doMock('../../../src/db/sqlite.js', () => ({
      getDb: () => ({ prepare: () => ({ get: () => ({ kind: 'early_off', makeup_dow: null, end_min: 900, note: '运动会' }) }) }),
    }));
    const mod = await import('../../../src/tracking/school-state.js');
    // Monday 15:20 (920) — period 6 is 14:55-15:40 (895-940), early_off at 15:00 (900)
    const s = mod.getSchoolState(bjDate('2026-06-15T15:20'));
    expect(s.phase).toBe('after_school');
    expect(s.selfLine).toContain('放学');
  });

  it('holiday override → not a school day, holiday line', async () => {
    vi.resetModules();
    vi.doMock('../../../src/env.js', () => ({
      env: () => ({ SCHOOL_SCHEDULE_ENABLED: true, DAILY_LIFE_PROFILE: 'school' }),
    }));
    vi.doMock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn() } }));
    vi.doMock('../../../src/db/sqlite.js', () => ({
      getDb: () => ({ prepare: () => ({ get: () => ({ kind: 'holiday', makeup_dow: null, end_min: null, note: '端午节' }) }) }),
    }));
    const mod = await import('../../../src/tracking/school-state.js');
    const s = mod.getSchoolState(bjDate('2026-06-15T08:10'));
    expect(s.isSchoolDay).toBe(false);
    expect(s.phase).toBe('holiday');
    expect(s.selfLine).toContain('放假');
    expect(s.selfLine).toContain('端午节');
  });
});
