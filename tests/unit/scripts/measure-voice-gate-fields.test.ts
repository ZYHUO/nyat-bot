import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * measure:voice 必须把"想说话但没出去"的两个数打出来（round 73）。
 *
 * 2026-09-23。round 68 量化出 1116 次回复被 trench 闸咽回（98% 是
 * just_answered）、round 72 量化出 2555 次思维链吃光——而这两个数
 * **此前只能 grep 日志才知道**。measure:voice 的 ⑤ 那行只显示漏斗五项
 * （asleep/legacy/bot未叫/绕过直摄/coalesce），完全看不到它们。
 *
 * 于是每一轮修复的效果都要手动 grep 一遍，而用户看到的"融不进去/
 * 前言不搭后语"恰恰主要来自这两个数——它们比回复率更接近病根。
 */
describe('measure:voice 的闸/截断计数', () => {
  const SRC = 'scripts/measure-voice.mts';

  it('① gate 对象有 blockedByGate 和 truncated 两个计数', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('blockedByGate: 0');
    expect(s).toContain('truncated: 0');
  });

  it('② 识别两种日志', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("m.includes('BLOCKED by trench gate')");
    expect(s).toContain("m.includes('空正文')");
  });

  it('③ 打到输出里（不是只算不用）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('被自己的闸咽回 ${gate.blockedByGate}');
    expect(s).toContain('思维链吃光 ${gate.truncated}');
  });

  it('④ 非零时给指引（不是光报数）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('if (gate.blockedByGate > 0 || gate.truncated > 0)');
    expect(s).toContain('比回复率更接近');
    // 指引里要点名三轮修复，否则看到 >0 不知道该查什么
    expect(s).toContain('round 68');
    expect(s).toContain('round 72');
  });
});
