import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * Heart reflect 覆写 why 之前必须过 cleanWhy（round 164）。
 *
 * 用户 2026-09-23 23:05 现场：`Heart decision` 的 why 是
 * `{刚骂完warp抽风，global还有救吗？` —— 前导 `{` 没剥掉。
 *
 * 根因：cleanWhy 只用在 parseHeart() 里，而 reflect（round 88 加的）会用
 * refined 覆写 parsed.why，那个 replace 只剥「」引号、不剥 {}[]。
 * 实测 09-21/22/23 三天 dirty why 532/352/211 条，全是这条路径漏的。
 *
 * 而 why 会注入 [你的念头] 给写手——这里脏了，下游拿到的是垃圾方向。
 */
describe('reflect 覆写 why 前过 cleanWhy', () => {
  const SRC = 'src/pipeline/heart/decision.ts';

  it('① refined 由 cleanWhy 产出，不是自己的半套正则', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(codeLines.some((l) => l.includes('const refined = cleanWhy('))).toBe(true);
    // 旧的那半套（只剥引号）不能再留在赋值里
    expect(s).not.toContain("replace(/^[「\"'\"]+|[」\"'\"]+$/g, '')");
  });

  it('② 覆写仍在 guard 之后（cleaned 为空就不覆写，保住原 why）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const cleanIdx = s.indexOf('const refined = cleanWhy(');
    const guardIdx = s.indexOf('if (refined.length >= 2)');
    const overrideIdx = s.indexOf('parsed = { ...parsed, why: refined }');
    expect(cleanIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(cleanIdx);
    expect(overrideIdx).toBeGreaterThan(guardIdx);
  });

  it('③ cleanWhy 本身仍剥前导 { （没被这次改动削弱）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("t.replace(/^[\\s{}[\\]\"'`]+/, '')");
  });
});
