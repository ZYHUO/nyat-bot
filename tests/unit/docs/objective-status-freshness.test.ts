import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 98: **OBJECTIVE-STATUS \u7684\u6570\u636e\u8868\u5fc5\u987b\u5e26\u65f6\u95f4\u6233\uff0c\u800c\u4e14\u53ea\u80fd\u6709\u4e00\u4e2a\u3002**
 *
 * Round 97 \u66f4\u65b0\u4e86\u8868\u683c\uff08topic-word 0\u21922\u6b21\uff09\uff0c\u4f46 L42 \u7684\u8bf4\u660e\u8fd8\u5199\u7740
 * "\u8868\u662f round 196 \u7684\u5feb\u7167"\u2014\u2014\u800c\u8868\u5934\u5df2\u7ecf\u6539\u6210 "09-24 07:22 \u5168\u65e5\u5fd7\u5b9e\u6d4b"\u3002
 * **\u540c\u4e00\u4efd\u6587\u6863\u91cc\u4e24\u5904\u53e3\u5f84\u4e0d\u4e00\u81f4**\uff0c\u800c round 47 \u6293\u8fc7\u7684\u5c31\u662f\u8fd9\u4e2a\u75c5\u3002
 *
 * \u8fd9\u6b21\u66f4\u9690\u2026\u2026\u56e0\u4e3a\u5b83\u4e0d\u662f"\u4e24\u4efd\u62f3\u9009\u540c\u4e00\u4e2a\u6570"\uff0c\u800c\u662f
 * "\u4e00\u4efd\u8bf4\u5feb\u7167\u3001\u4e00\u4efd\u8bf4\u5b9e\u6d4b"\u2014\u2014\u4e24\u8005\u90fd\u5bf9\uff0c\u4f46\u6307\u7684\u4e0d\u662f\u540c\u4e00\u65f6\u523b\u7684\u4e8c\u4e8b\u3002
 *
 * \u6240\u4ee5\u89c4\u5219\uff1a**\u6570\u636e\u8868\u53ea\u80fd\u6709\u4e00\u4e2a\u65f6\u95f4\u6233\uff0c\u4e14\u8bf4\u660e\u6587\u5b57\u5fc5\u987b\u548c\u5b83\u4e00\u81f4**\u3002
 */

describe('OBJECTIVE-STATUS 数据表的时间戳一致', () => {
  const read = (): string[] => fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');

  it('① 数据表表头带日期时间戳（不带 = 快照 = 会过期）', () => {
    const lines = read();
    const header = lines.find((l) => l.startsWith('| 闸 |'));
    expect(header, '找不到"| 闸 |"表头').toBeDefined();
    // MM-DD HH:MM 或 YYYY-MM-DD 之类
    expect(header!).toMatch(/\d{2}-\d{2} \d{2}:\d{2}|\d{4}-\d{2}-\d{2}/);
  });

  it('② 表上方的说明文字必须引用同一个时间戳（round 98 抓到的不一致）', () => {
    const lines = read();
    const hi = lines.findIndex((l) => l.startsWith('| 闸 |'));
    expect(hi).toBeGreaterThan(-1);
    const header = lines[hi]!;
    const stamp = header.match(/(\d{2}-\d{2} \d{2}:\d{2})/)?.[1];
    // 往上找说明段（表头前 10 行内），必须提到这个时间戳或"逐轮更新"
    const above = lines.slice(Math.max(0, hi - 10), hi).join('\n');
    expect(stamp, '表头没有 MM-DD HH:MM 形状的时间戳').toBeDefined();
    // round 98 收紧：第一版让"逐轮更新"也能过，结果改表头时间戳不红——
    // 而那就是 round 97 的病（表头新、说明旧）。现在要求字面一致。
    expect(above.includes(stamp!),
      `表头时间戳 ${stamp} 没出现在它上方的说明里（round 98）`).toBe(true);
  });

  it('③ 没有第二处"round 196 快照"同时存在（round 47 两份拷贝的变形）', () => {
    const s = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8');
    // "round 196 的快照"是旧标注；现在只能是"09-24 07:22 全日志实测"
    const oldWay = s.split('\n').filter((l) => l.includes('round 196 \u7684\u5feb\u7167'));
    const newWay = s.split('\n').filter((l) => l.includes('\u5168\u65e5\u5fd7\u5b9e\u6d4b'));
    expect(newWay.length, '没有实测标注').toBeGreaterThan(0);
    expect(oldWay, `还有 ${oldWay.length} \u5904\u8bf4"round 196 \u7684\u5feb\u7167"\u2014\u2014\u548c\u8868\u5934\u51b2\u7a81`).toEqual([]);
  });

  it('④ topic-word 行的数字和备注不自相矛盾（round 91 起它响了）', () => {
    const s = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8');
    const row = s.split('\n').find((l) => l.startsWith('| \u8bdd\u9898\u8bcd\u590d\u7528'));
    expect(row, '找不到话题词复用行').toBeDefined();
    expect(row!).toMatch(/\u62e2 [1-9]\d* \u6b21/);   // round 111: 数字随生产计数走，但不许回 0
    // 备注不能再是"拦 0 次只能读作没机会"（那已过期）
    expect(row!).not.toContain('\u62e2 0 \u6b21');
  });

  it('④b 所有五行的计数列都不能没有数字（round 146：把④扩到全部行）', () => {
    // round 145 审出来：④只覆盖 topic-word 一行，另四行还是硬编计数值。
    // 那条不需要把计数列也改成正则（round 145：同行里可以两种数并存），
    // 但至少要**没有一行完全没有数字**——那是表格退化的信号。
    const lines = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');
    const hi = lines.findIndex((l) => l.startsWith('| \u95f8 |'));
    const rows = lines.slice(hi + 2).filter((l) => l.startsWith('| '));
    expect(rows.length, '\u95f8\u884c\u5c11\u4e8e 5').toBeGreaterThanOrEqual(5);
    const empty = rows.filter((r) => !/\d/.test(r.split('|')[2] ?? ''));
    expect(empty, '\u8fd9\u4e9b\u884c\u7684\u8ba1\u6570\u5217\u6ca1\u6709\u4efb\u4f55\u6570\u5b57\uff1a\n  ' + empty.join('\n  ')).toEqual([]);
  });
});

describe('文档数字必须带覆盖面（round 121）', () => {
  it('⑤ 表头写清"全日志实测"这类覆盖面（不写 = 读的人不知道是全部还是一条）', () => {
    const lines = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');
    const header = lines.find((l) => l.startsWith('| 闸 |'));
    expect(header).toBeDefined();
    expect(header!, '\u8868\u5934\u6ca1\u5199\u8986\u76d6\u9762\uff08\u5168\u65e5\u5fd7\u5b9e\u6d4b / \u5feb\u7167\uff09').toMatch(/全日志实测|快照/);
  });

  it('⑥ 说明段也写覆盖面，且与表头一致', () => {
    const lines = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');
    const hi = lines.findIndex((l) => l.startsWith('| 闸 |'));
    const above = lines.slice(Math.max(0, hi - 10), hi).join('\n');
    expect(above).toMatch(/全日志实测|快照/);
  });
});
