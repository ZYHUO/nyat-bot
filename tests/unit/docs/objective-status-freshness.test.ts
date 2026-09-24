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
});
