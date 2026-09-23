import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * --since 的时间解析 + ③ 的分母守卫（round 93）。
 *
 * 1. round 51 的 bug（藏了 42 轮）：`timePart.padStart(8,'0').slice(0,8)`
 *    是想把 HH:MM 补成 HH:MM:SS，但 padStart 是左补——
 *    '11:21'.padStart(8,'0') = '00011:21'，Date.parse 得 NaN，
 *    fallback 到当天 00:00。round 51 我验的是 '2026-09-22 00:00'
 *    （timePart 恰好不用补），绕过了。
 *
 * 2. round 92 我差点犯的罪：deploy 前后对比，前 343 条带锚 / 后 3 条，
 *    就报"后 0 组重复 = 修好了"。没有分母的 0 不是证据。
 */
describe('measure-voice 的窗口与分母', () => {
  const SRC = 'scripts/measure-voice.mts';

  it('no padStart(8) on time (that bug hid for 42 rounds)', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).not.toContain("padStart(8, '0')");
  });

  it('splits by colon then pads each segment', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("const [hh = '0', mm = '0', ss = '0'] = timePart.split(':')");
    expect(s).toContain("const hms = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:${ss.padStart(2, '0')}`");
  });

  it('metric 3 has a denominator guard (warns when anchored < 20)', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('const anchored = [...anchor.values()].reduce((a, b) => a + b, 0);');
    expect(s).toContain('if (anchored < 20) {');
    expect(s).toContain('没有分母的 0');
  });

  it('same 20 threshold as the inbound guard (one yardstick)', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('if (msgs < 20) {');
    expect(s).toContain('if (anchored < 20) {');
  });
});
