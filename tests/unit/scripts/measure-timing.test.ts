import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 接话延迟三段账（round 107）。
 *
 * round 103-106 诊断出"很难融入话题"是延迟问题，但那些数字只存在于
 * commit message 里。这里固化成 `npm run measure:timing`。
 *
 * 基线（09-23）：① 11.3s/23.2s · ② 19.4s/42.3s · 快接 51%/84%/89%。
 */
describe('measure:timing', () => {
  const SRC = 'scripts/measure-timing.mts';

  it('① 量三段：锚点→决策 / 决策→发送 / 快接率', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('锚点消息 → 心流决策');
    expect(s).toContain('心流决策 → 发送');
    expect(s).toContain('快接率');
  });

  it('② 三个窗口固定 30s / 300s / 600s', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('const wins = [30_000, 300_000, 600_000]');
  });

  it('③ 有 --day 参数（默认今天）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('--day=');
    expect(s).toContain('new Date().toISOString().slice(0, 10)');
  });

  it('④ 输出带基线（不然数字没法解读）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('基线 09-23');
    expect(s).toContain('51%');
  });

  it('⑤ npm script 叫 measure:timing', () => {
    const p = fs.readFileSync('package.json', 'utf8');
    expect(p).toContain('"measure:timing"');
    expect(p).toContain('scripts/measure-timing.mts');
  });

  it('⑥ 说明了"要对上融得进需要什么"（不只是报数）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('总延迟压到 20s 内');
  });

  it('⑦ 输出行里说明 ① 的边界是糊的（round 139：别引用细分）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 只查 console.log 的输出行，不查注释——注释里也有同样的话，
    // 光查字符串的话改了输出行测试还是绿（round 140 实测过）。
    const outLines = s.split('\n').filter((l) => l.includes('console.log'));
    expect(outLines.some((l) => l.includes('① 的边界是糊的'))).toBe(true);
    expect(outLines.some((l) => l.includes('Telegram 发布延迟'))).toBe(true);
    expect(outLines.some((l) => l.includes('方向可用，具体细分数字别引用'))).toBe(true);
  });
});
