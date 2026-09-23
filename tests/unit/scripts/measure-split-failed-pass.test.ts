import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * ② 必须把 LLM 失败的 pass 拆出来（round 117）。
 *
 * round 116 交叉验证发现 decision:pass 1400 vs meta:pass 1654，
 * 差 254 全是 llm_failed。旧口径把它们算成正常 pass，
 * 于是"它真的在读上下文"这个结论混了 14% 的哑巴。
 */
describe('measure:voice 的 failed-pass 拆分', () => {
  const SRC = 'scripts/measure-voice.mts';

  it('① 数 Meta heart: pass 里的 llm_failed', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("m === 'Meta heart: pass'");
    expect(s).toContain("why === 'llm_failed' || why === 'parse_failed'");
    expect(s).toContain('metaFailedPass');
  });

  it('② 单独报一行（不并入正常 pass 的百分比）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('次 pass 是 LLM 失败 fail-closed');
    expect(s).toContain('真实"选择不说"要扣掉这部分');
  });

  it('③ 分母含 failedPass（不能只除 actTotal）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('actTotal + metaFailedPass');
  });

  it('④ 注释指向 round 116 的交叉验证（防下一个人精简）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('round 116');
  });

  it('⑤ 实测今天确实有（不是空转）', () => {
    const { execSync } = require('node:child_process');
    const out = execSync('npx tsx scripts/measure-voice.mts -- --day=2026-09-23 2>/dev/null', { encoding: 'utf8' });
    expect(out).toContain('LLM 失败 fail-closed');
  });
});
