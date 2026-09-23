import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 闸的验证据一键查（round 111）。
 *
 * 四个闸的"拦住 0 次"我每轮都要手动 grep + 数分母，而分母经常 <20。
 * 这个脚本把判断固化。其中 ① 已被生产验证（round 86：部署后 1 分钟
 * 就挡住一次 uzumaru_geoip_bot）。
 */
describe('gate:evidence 脚本', () => {
  const SRC = 'scripts/check-gate-evidence.sh';

  it('① 覆盖四个闸', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    for (const marker of ['重复锚点闸', '代发目标不在群', '人在纠正止损', '同群同文本去重']) {
      expect(s).toContain(marker);
    }
  });

  it('② 用 awk 数（grep -c 无匹配时返回 1，|| echo 0 会多一个换行）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('awk');
    // 注释里会提到 grep -c（解释为什么不用它），所以只禁**代码行**
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(codeLines.some((l) => l.includes('grep -c'))).toBe(false);
  });

  it('③ 报分母（不然 0 读不出结论）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('分母');
    expect(s).toContain('>=20');
  });

  it('④ 注明口径是全累计（round 40 的教训）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('全日志累计');
  });

  it('⑤ npm script 叫 gate:evidence', () => {
    const p = fs.readFileSync('package.json', 'utf8');
    expect(p).toContain('"gate:evidence"');
    expect(p).toContain('scripts/check-gate-evidence.sh');
  });

  it('⑥ 语法是合法的 bash', () => {
    const { execSync } = require('node:child_process');
    execSync('bash -n ' + SRC);
    expect(true).toBe(true);
  });
});
