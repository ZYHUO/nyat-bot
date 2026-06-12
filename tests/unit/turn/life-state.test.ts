import { describe, it, expect, afterEach } from 'vitest';
import {
  getLifeState,
  daySchedule,
  setBedtimeShift,
  effectiveSleepMin,
  _resetBedtimeShifts,
} from '../../../src/tracking/life-state.js';

afterEach(() => _resetBedtimeShifts());

/** 构造"北京时间 HH:MM"对应的 UTC Date(北京=UTC+8) */
function bj(dateStr: string, hh: number, mm = 0): Date {
  const utcMs = Date.parse(`${dateStr}T00:00:00Z`) + ((hh - 8) * 60 + mm) * 60_000;
  return new Date(utcMs);
}

describe('life-state (#5 作息 + #12 lazy day)', () => {
  it('schedule is deterministic per day and varies across days', () => {
    const a1 = daySchedule('2026-06-08');
    const a2 = daySchedule('2026-06-08');
    expect(a1).toEqual(a2);
    const days = Array.from({ length: 10 }, (_, i) => daySchedule(`2026-06-${10 + i}`));
    expect(new Set(days.map((d) => d.wakeMin)).size).toBeGreaterThan(3);
  });

  it('deep night (3am) → sleeping: low energy, slow, groggy hint', () => {
    const s = getLifeState(bj('2026-06-08', 3, 0));
    expect(s.state).toBe('sleeping');
    expect(s.energy).toBeLessThan(0.2);
    expect(s.speedFactor).toBeGreaterThan(2);
    expect(s.hint).toContain('深夜');
  });

  it('mid-afternoon → normal on non-lazy days: full energy, no hint', () => {
    // 找一个非 lazy 的日期
    for (let d = 8; d < 28; d++) {
      const dateStr = `2026-06-${String(d).padStart(2, '0')}`;
      if (!daySchedule(dateStr).lazyDay) {
        const s = getLifeState(bj(dateStr, 15, 30));
        expect(s.state).toBe('normal');
        expect(s.energy).toBeGreaterThan(0.7);
        expect(s.speedFactor).toBe(1);
        expect(s.hint).toBeNull();
        return;
      }
    }
    throw new Error('no non-lazy day found in range');
  });

  it('lunch window → eating with hint', () => {
    for (let d = 8; d < 28; d++) {
      const dateStr = `2026-06-${String(d).padStart(2, '0')}`;
      const sc = daySchedule(dateStr);
      if (!sc.lazyDay) {
        const s = getLifeState(bj(dateStr, Math.floor(sc.lunchStart / 60), sc.lunchStart % 60 + 5));
        expect(s.state).toBe('eating');
        expect(s.hint).toContain('吃饭');
        return;
      }
    }
  });

  it('lazy days exist at roughly ~10% frequency and carry the摆烂 hint', () => {
    let lazy = 0;
    const total = 400;
    for (let i = 0; i < total; i++) {
      const date = new Date(Date.parse('2026-01-01') + i * 86400_000).toISOString().slice(0, 10);
      if (daySchedule(date).lazyDay) lazy++;
    }
    expect(lazy / total).toBeGreaterThan(0.04);
    expect(lazy / total).toBeLessThan(0.2);

    for (let d = 8; d < 60; d++) {
      const date = new Date(Date.parse('2026-06-01') + d * 86400_000).toISOString().slice(0, 10);
      if (daySchedule(date).lazyDay) {
        const s = getLifeState(bj(date, 15, 0));
        expect(s.state).toBe('lazy');
        expect(s.energy).toBeLessThanOrEqual(0.45);
        expect(s.hint).toMatch(/摆烂|蔫/);
        return;
      }
    }
  });

  it('午睡窗(v2)→ sleeping + nap 标记,浅睡降速;~60% 的天有午睡', () => {
    let napDays = 0;
    const total = 100;
    for (let i = 0; i < total; i++) {
      const date = new Date(Date.parse('2026-03-01') + i * 86400_000).toISOString().slice(0, 10);
      if (daySchedule(date).napStart !== null) napDays++;
    }
    expect(napDays / total).toBeGreaterThan(0.4);
    expect(napDays / total).toBeLessThan(0.8);

    for (let d = 1; d < 28; d++) {
      const date = `2026-06-${String(d).padStart(2, '0')}`;
      const sc = daySchedule(date);
      if (sc.napStart !== null) {
        const s = getLifeState(bj(date, Math.floor(sc.napStart / 60), (sc.napStart % 60) + 2));
        expect(s.state).toBe('sleeping');
        expect(s.nap).toBe(true);
        expect(s.speedFactor).toBe(2.0);
        expect(s.hint).toContain('午睡');
        return;
      }
    }
    throw new Error('no nap day found');
  });

  it('动态就寝(v2):话多 shift 提前就寝点,话少推迟;夹在 [22:30, 02:00]', () => {
    // 找一个 seeded 就寝点跨午夜(>=1440)的日期:shift -60 后落回今天
    for (let d = 1; d < 60; d++) {
      const date = new Date(Date.parse('2026-06-01') + d * 86400_000).toISOString().slice(0, 10);
      const sc = daySchedule(date);
      if (sc.sleepMin >= 1450 && sc.sleepMin <= 1490) {
        // 无 shift:23:55 还醒着(夜猫子);shift -60 后已过就寝点 → 睡了
        const t = bj(date, 23, 55); // minutes = 1435
        expect(getLifeState(t).state).not.toBe('sleeping');
        setBedtimeShift(date, -60);
        expect(effectiveSleepMin(date)).toBe(sc.sleepMin - 60);
        expect(getLifeState(t).state).toBe('sleeping');
        // 正向 shift 被钳在次日 02:00
        setBedtimeShift(date, 999);
        expect(effectiveSleepMin(date)).toBe(26 * 60);
        return;
      }
    }
    throw new Error('no suitable date found');
  });

  it('动态就寝(v2):凌晨段用昨天的 shift 判"昨晚几点睡的"', () => {
    // 昨晚晚睡(shift +45):昨晚就寝点投影到今天更晚 → 投影前的凌晨时刻不算睡
    for (let d = 1; d < 60; d++) {
      const date = new Date(Date.parse('2026-06-01') + d * 86400_000).toISOString().slice(0, 10);
      const sc = daySchedule(date);
      if (sc.sleepMin >= 1440 && sc.sleepMin <= 1450) {
        const next = new Date(Date.parse(date) + 86400_000).toISOString().slice(0, 10);
        // 今天 00:20:无 shift 时 prevSleepStartToday = sleepMin-1440 ∈ [0,10] → 已睡
        expect(getLifeState(bj(next, 0, 20)).state).toBe('sleeping');
        // 昨晚 +45 晚睡 → 投影 ∈ [45,55] → 00:20 还没睡(夜猫子加班中)
        setBedtimeShift(date, 45);
        expect(getLifeState(bj(next, 0, 20)).state).not.toBe('sleeping');
        return;
      }
    }
    throw new Error('no suitable date found');
  });

  it('late night before sleep (23:00 when sleeping at 23:30+) → night-owl slowdown', () => {
    for (let d = 8; d < 28; d++) {
      const dateStr = `2026-06-${String(d).padStart(2, '0')}`;
      const sc = daySchedule(dateStr);
      if (!sc.lazyDay && sc.sleepMin > 23 * 60 + 10) {
        const s = getLifeState(bj(dateStr, 23, 5));
        if (s.state === 'normal') {
          expect(s.speedFactor).toBeGreaterThan(1);
          expect(s.hint).toContain('夜深');
          return;
        }
      }
    }
  });
});
