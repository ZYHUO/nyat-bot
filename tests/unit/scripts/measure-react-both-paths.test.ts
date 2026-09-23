import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * measure:voice 必须同时收两条路径的 react 日志（round 114）。
 *
 * round 54 把 react 接到 Meta 路径（生产主路径），日志名改成
 * Meta heart: reacted。而 measure-voice 还在数旧名 heart: reacted
 * 所以恒报 0。今天全天 27 次真发送，量具一个都没看到。
 *
 * 这是"改了代码没同步量具"——这个会话反复出现的形状。
 */
describe('measure:voice 的 react 计数', () => {
  const SRC = 'scripts/measure-voice.mts';

  it('accepts both log names', () => {
    // round 142：只查**未注释的**代码行。注释掉的 `// if (m === 'heart:...`
    // 仍含该字符串，查全文字符串的话删掉代码测试还是绿。
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(codeLines.some((l) => l.includes("m === 'heart: reacted' || m === 'Meta heart: reacted'"))).toBe(true);
  });

  it('comment explains why (so nobody trims it later)', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf("m === 'heart: reacted' || m === 'Meta heart: reacted'");
    expect(i).toBeGreaterThan(-1);
    const before = s.slice(Math.max(0, i - 300), i);
    expect(before).toContain('Meta');
    expect(before).toContain('round 54');
  });

  it('both names come from real sources', () => {
    const adapter = fs.readFileSync('src/meta/heart-adapter.ts', 'utf8');
    expect(adapter).toContain("'Meta heart: reacted'");
    const heart = fs.readFileSync('src/pipeline/heart/heart.ts', 'utf8');
    expect(heart).toContain("'heart: reacted'");
  });

  it('emoji distribution still there (guard against constant output)', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('reactedEmoji');
  });
});
