import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * round 171: **src/ 里不得有 CJK 范围的 unicode 转义字面量。**
 *
 * 这条取代 round 154 在两个测试里写的窄判据：
 *   expect(s).not.toContain('\—');
 *   expect(s).not.toContain('\不');
 *
 * 那两条**不是假绿**（round 150 曾这样判，round 151 更正）：它们确实在查
 * "源码里不得出现那 6 个字符的字面文本"，而且一直有效。但它们**只查 2 个码**——
 * round 151 全仓量出 src 里有 415 处转义（18 个文件），写别的码位就漏。
 *
 * **判据**：扫所有 src 下的 .ts，报"落在 CJK 范围（U+4E00-9FFF）或常见 CJK 标点"的
 * 反斜杠-u 转义。**不解非 CJK 的**：round 153 发现 `/​/`（匹配零宽空格）和
 * `[\s　]` 是故意的正则，不能一起清。
 *
 * 这条是 round 151/152/153 的收尾：那三轮清了 415 处，现在是守卫。
 */

const SELF = 'tests/unit/docs/no-unicode-escapes-in-src.test.ts';

/** round 153 的分类：仅 CJK 范围 + 常见 CJK 标炶算“该解”。 */
const isCjkEscape = (cp: number): boolean => {
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;
  return [0x3001, 0x3002, 0xff0c, 0xff1a, 0xff1b, 0xff01, 0xff1f,
    0x3010, 0x3011, 0x2014, 0x201c, 0x201d, 0x300a, 0x300b, 0x2026, 0x00b7].includes(cp);
};

const countCjkEscapes = (file: string): number => {
  const s = fs.readFileSync(file, 'utf8');
  const hits = s.match(/\\u([0-9a-fA-F]{4})/g) ?? [];
  return hits.filter((h) => isCjkEscape(parseInt(h.slice(2), 16))).length;
};

const allSrcFiles = (): string[] =>
  execSync('find src -name "*.ts" | sort', { encoding: 'utf8' }).split('\n').filter((l) => l.trim() !== '');

describe('src/ 不得有 CJK 范围的 unicode 转义字面量', () => {
  it('本守卫自己不含（round 130：查模式的守卫会命中自己）', () => {
    expect(countCjkEscapes(SELF)).toBe(0);
  });

  it('没有任何 src 文件含 CJK 转义（round 151/152/153 清完后的守卫）', () => {
    const bad: string[] = [];
    for (const f of allSrcFiles()) {
      const n = countCjkEscapes(f);
      if (n > 0) bad.push(`${f} (${n} 处)`);
    }
    expect(bad, '这些 src 文件里还有 CJK 转义：\n  ' + bad.join('\n  ')).toEqual([]);
  });

  it('故意的非 CJK 转义仍允许（round 153 的边界）', () => {
    // 存在即合法：/​/ 与 [\s　] 是正则里的不可见字符。
    let total = 0;
    for (const f of allSrcFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      total += (s.match(/\\u[0-9a-fA-F]{4}/g) ?? []).length;
    }
    expect(total, '非 CJK 转义总数变了——确认是有意的正则改动').toBe(3);
  });
});
