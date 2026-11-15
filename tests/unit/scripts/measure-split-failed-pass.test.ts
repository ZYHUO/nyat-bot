import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { reportFixture } from '../../helpers/log-script.js';
const fixture = reportFixture();
afterAll(() => fixture.cleanup());

/**
 * ② 必须把 LLM 失败的 pass 拆出来（round 117）。
 *
 * round 116 交叉验证发现 decision:pass 1400 vs meta:pass 1654，
 * 差 254 全是 llm_failed。旧口径把它们算成正常 pass，
 * 于是"它真的在读上下文"这个结论混了 14% 的哑巴。
 */
describe('measure:voice 的 failed-pass 拆分', { timeout: 30_000 }, () => {
  const SRC = 'scripts/measure-voice.mts';

  it('① 数 Meta heart: pass 里的 llm_failed', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("m === 'Meta heart: pass'");
    expect(s).toContain("why === 'llm_failed' || why === 'parse_failed'");
    expect(s).toContain('metaFailedPass');
  });

  it('② 单独报一行（不并入正常 pass 的百分比）', () => {
    // round 141/142：只查**未注释的** console.log 行。
    // 第一版只过滤 console.log —— 而把输出行注释掉后那行
    // 仍是 `//console.log(...)`，照样含 'console.log'，测试还是绿。
    const s = fs.readFileSync(SRC, 'utf8');
    const outLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//') && l.includes('console.log'));
    expect(outLines.some((l) => l.includes('次 pass 是 LLM 失败 fail-closed'))).toBe(true);
    expect(outLines.some((l) => l.includes('要扣掉这部分'))).toBe(true);
  });

  it('③ 分母含 failedPass（不能只除 actTotal）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('actTotal + metaFailedPass');
  });

  it('④ 注释指向 round 116 的交叉验证（防下一个人精简）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('round 116');
  });

  it('⑤ 合成输入区分两次失败、一条正常pass和独立shadow错误', () => {
    const result = fixture.run(SRC, ['--day=2026-11-15']);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('2 次 pass 是 LLM 失败 fail-closed');
    expect(result.out).toContain('占 33%');
    expect(result.out).toContain('pass 1 (25%)');
    expect(result.out).toContain('1 次影子决策崩掉');
  });

  it('⑥ 影子决策的崩掉也数（round 150：它不进 pass，但也没进过任何仪表盘）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(codeLines.some((l) => l.includes("m === 'shadow decision THREW (counted as silent)'"))).toBe(true);
    expect(codeLines.some((l) => l.includes('shadowThrew'))).toBe(true);
    const outLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//') && l.includes('console.log'));
    expect(outLines.some((l) => l.includes('影子决策崩掉'))).toBe(true);
  });
});
