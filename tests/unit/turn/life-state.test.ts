import { describe, it, expect } from 'vitest';
import { getLifeState, daySchedule } from '../../../src/tracking/life-state.js';

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
