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

  it('④ 分母按 UTC 今天切（round 40 的教训：累计会混入修复前样本）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(codeLines.some((l) => l.includes('date -u +%Y-%m-%d'))).toBe(true);
    const echoLines = s.split('\n').filter((l) => l.includes('echo '));
    expect(echoLines.some((l) => l.includes('UTC'))).toBe(true);
  });

  it('⑤ npm script 叫 gate:evidence', () => {
    const p = fs.readFileSync('package.json', 'utf8');
    expect(p).toContain('"gate:evidence"');
    expect(p).toContain('scripts/check-gate-evidence.sh');
  });


  it('⑦ 被拦的具体内容单独列出（round 131：否则拦截看不见）', () => {
    // 只查 echo 行：`anchor=%s recent=%s` 也出现在注释里，
    // 查全文字符串的话删掉输出行测试还是绿（round 140 同款教训）。
    // 判据：该字面量出现在**非注释行**里就够。anchor=%s recent=%s 在
    // python heredoc 的 print 里（不是 echo），所以不能只查 echo 行。
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(codeLines.some((l) => l.includes('最近被①拦下的'))).toBe(true);
    expect(codeLines.some((l) => l.includes('anchor=%s recent=%s'))).toBe(true);
  });

  it('⑥ 的注释记着 round 123 的误判（别再把"没拦"当"没发生"）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('round 123');
    expect(s).toContain('闸自己的日志是它动作的唯一观测点');
  });
  it('⑥ 语法是合法的 bash', () => {
    const { execSync } = require('node:child_process');
    execSync('bash -n ' + SRC);
    expect(true).toBe(true);
  });
});
