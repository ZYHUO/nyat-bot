import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * round 148: **测试文件里不得有反斜杠-u 转义字面量。**
 *
 * Round 147 发现 `objective-status-freshness.test.ts` 里有反斜杠加 u 这种字面
 * escape，导致我改不了它——python/edit 写真字符永远匹配不上。
 *
 * 而 round 148 量全仓（不是抽样）：**13 个测试文件、1100 处**。
 * Round 147 我只查了卡住的那个文件就下结论（round 133/134 那个覆盖面错误的又一次）。
 *
 * 为什么要守：
 *   - 人读不懂（grep 关键字找不到那一行）
 *   - 我改不了（卡了两次）
 *   - 下一个人 edit 会再卡一次
 * "能跑"不是"可维护"——而可维护的最低标准是 grep 关键词能找到那一行。
 *
 * **边界（round 115 B 级 + round 137 台账）**：存量 1100 处不要一次清完
 * （改错风险大于收益，round 175 的错字就是这么来的）。这里只阻**新增**：
 * 已有的记进台账，下次改到那个文件时用 sed 一次做完，别手工。
 *
 * **而这个守卫自己的第一版就是 406 处转义**——因为它是我用 python heredoc
 * 写的，和那 13 个文件同一个病因。重写成真字符后才是 0。
 * 这正是 round 128/130 立的规矩：查模式的守卫会命中自己。
 */

const SELF = 'tests/unit/no-unicode-escapes-in-tests.test.ts';

const countEscapes = (file: string): number => {
  const s = fs.readFileSync(file, 'utf8');
  // 反斜杠 + u + 4 位十六进制。在 JS 源码里单独出现时才算是"该写真字符却写了转义"。
  return (s.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length;
};

const allTestFiles = (): string[] =>
  execSync('find tests -name "*.test.ts" | sort', { encoding: 'utf8' })
    .split('\n').filter((l) => l.trim() !== '');

describe('测试文件不得有反斜杠-u 转义字面量', () => {
  it('本守卫自己不含（round 130：查模式的守卫会命中自己）', () => {
    expect(countEscapes(SELF)).toBe(0);
  });

  it('转义文件数不超过 round 148 量出的 13 个基线（只阻新增）', () => {
    const offenders: string[] = [];
    for (const f of allTestFiles()) {
      if (f.includes(SELF)) continue;
      if (countEscapes(f) > 0) offenders.push(f);
    }
    // 存量 13 个文件。这条不要求清零，但不得新增。
    expect(offenders.length, '比 round 154 记的 9 个多，有新增：\n  ' + offenders.join('\n  '))
      .toBeLessThanOrEqual(9);   // round 154: 从 13 清到 9
  });

  it('台账记了存量基线（round 137：基线数字要有家）', () => {
    const ki = fs.readFileSync('docs/known-issues.md', 'utf8');
// round 155: 查“台账里有这一行”，不查具体数字——数字会随清理变（round 154 红过一次）。
    // 这样仍能抓到“台账被删了那行”，但不会因正当更新而红。
    expect(ki, 'known-issues 里没记这个基线（那一行被删了？）').toContain('含反斜杠-u 转义字面量的测试文件');
  });
});
