import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 139: **台账每行必须写清它数的是哪个集合。**
 *
 * Round 137 建台账（线 + 量于 + 何时立），round 138 第一次复查就发现
 * "缺统 logger.info = 19" 这一行的集合没说清：round 95 数的是
 * "只有 debug"（19），而我复查时按字面数成"完全没有 info"（13）。
 *
 * 结果得出"u4ece 19 掉到 13，变好了"——那是个假信号。
 *
 * 这里把台账的格式钨住：每行必须同时有
 *   · 一个数字（基线）
 *   · round NN（量于）
 *   · 一个条件句（何时立）
 * 而且——round 138 新加的那条——**如果同一项有多个口径，必须分别标出**。
 */

const SRC = 'docs/known-issues.md';

describe('基线数字台账的格式', () => {
  const rows = (): string[] => {
    const lines = fs.readFileSync(SRC, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.includes('基线数字台账'));
    expect(start, '找不到台账节').toBeGreaterThan(-1);
    const out: string[] = [];
    // round 139: 台账是文件最后一节（没有下一个 ## 结束它），
    // 所以结束条件必须允许走到 EOF。
    for (let i = start; i < lines.length; i++) {
      if (i > start && lines[i]!.startsWith('## ')) break;
      if (lines[i]!.startsWith('| ') && !lines[i]!.startsWith('|---')) out.push(lines[i]!);
    }
    return out;
  };

  it('① 表头有"项/基线/量于/什么时候该立守卫"四列', () => {
    const r = rows();
    const header = r[0]!;
    expect(header).toContain('项');
    expect(header).toContain('基线');
    expect(header).toContain('量于');
    expect(header).toContain('立');
  });

  it('② 每行：有数字 + round NN + 一个条件词', () => {
    const r = rows().slice(1);
    expect(r.length, '台账行为 0').toBeGreaterThanOrEqual(5);
    const bad: string[] = [];
    for (const line of r) {
      const hasNum = /\d/.test(line);
      // round 139: **只查"量于"那一列**——第一片查整行，而备注列里也可能写
      // "round 138 复查"，删掉量于列它仍然绿（round 128 那个"选点命中别处"的又一次）。
      // round 139 take 2: split('|') 产生 ['', 项, 基线, 量于, 何时立, ''] ——**6 个元素，量于在 index 3**。
      // 第一片我查 cols[2]（基线）所以正常行也红。现在改成最直观的形状：
      // 整行里必须有一个**完整的单元格**就是 "round NN"。
      const hasRound = /\|\s*round \d+(\s*\/\s*\d+)?\s*\|/.test(line);
      const hasCond = /[大小高低超过超出多少]|<|>|溢出|下降|>\s*0|<\s*\d/.test(line);
      if (!hasNum || !hasRound || !hasCond) bad.push(line.slice(0, 60));
    }
    expect(bad, '这些行缺数字/轮次/条件：\n  ' + bad.join('\n  ')).toEqual([]);
  });

  it('③ round 138 那行不许把两个口径混成一个数', () => {
    const r = rows().slice(1);
    const row = r.find((l) => l.includes('incrCounter') || l.includes('logger.info'));
    expect(row, '找不到 incrCounter 那行').toBeDefined();
    // 必须出现两个分别标的数，或显式说明口径
    const numbers = (row!.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n < 100);
    expect(numbers.length, `只有 ${numbers.length} 个数字——两个口径要分开标`).toBeGreaterThanOrEqual(2);
  });

  it('④ 不是空表（至少有 5 行有效项）', () => {
    expect(rows().length - 1).toBeGreaterThanOrEqual(5);
  });
});
