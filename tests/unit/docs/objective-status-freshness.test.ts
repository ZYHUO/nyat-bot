import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 98: **OBJECTIVE-STATUS 的数据表必须带时间戳，而且只能有一个。**
 *
 * Round 97 更新了表格\uff08topic-word 0\u21922次\uff09，但 L42 的说明还写着
 * "表是 round 196 的快照"——而表头已经改成 "09-24 07:22 全日志实测"。
 * **同一份文档里两处口径不一致**，而 round 47 抓过的就是这个病。
 *
 * 这次更隐……因为它不是"两份拳选同一个数"，而是
 * "一份说快照、一份说实测"——两者都对，但指的不是同一时刻的二事。
 *
 * 所以规则：**数据表只能有一个时间戳，且说明文字必须和它一致**。
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
    const oldWay = s.split('\n').filter((l) => l.includes('round 196 的快照'));
    const newWay = s.split('\n').filter((l) => l.includes('全日志实测'));
    expect(newWay.length, '没有实测标注').toBeGreaterThan(0);
    expect(oldWay, `还有 ${oldWay.length} 处说"round 196 的快照"——和表头冲突`).toEqual([]);
  });

  it('④ topic-word 行的数字和备注不自相矛盾（round 91 起它响了）', () => {
    const s = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8');
    const row = s.split('\n').find((l) => l.startsWith('| 话题词复用'));
    expect(row, '找不到话题词复用行').toBeDefined();
    expect(row!).toMatch(/拢 [1-9]\d* 次/);   // round 111: 数字随生产计数走，但不许回 0
    // 备注不能再是"拦 0 次只能读作没机会"（那已过期）
    expect(row!).not.toContain('拢 0 次');
  });

  it('④b 所有五行的计数列都不能没有数字（round 146：把④扩到全部行）', () => {
    // round 145 审出来：④只覆盖 topic-word 一行，另四行还是硬编计数值。
    // 那条不需要把计数列也改成正则（round 145：同行里可以两种数并存），
    // 但至少要**没有一行完全没有数字**——那是表格退化的信号。
    const lines = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');
    const hi = lines.findIndex((l) => l.startsWith('| 闸 |'));
    const rows = lines.slice(hi + 2).filter((l) => l.startsWith('| '));
    expect(rows.length, '闸行少于 5').toBeGreaterThanOrEqual(5);
    const empty = rows.filter((r) => !/\d/.test(r.split('|')[2] ?? ''));
    expect(empty, '这些行的计数列没有任何数字：\n  ' + empty.join('\n  ')).toEqual([]);
  });
});

describe('文档数字必须带覆盖面（round 121）', () => {
  it('⑤ 表头写清"全日志实测"这类覆盖面（不写 = 读的人不知道是全部还是一条）', () => {
    const lines = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');
    const header = lines.find((l) => l.startsWith('| 闸 |'));
    expect(header).toBeDefined();
    expect(header!, '表头没写覆盖面\uff08全日志实测 / 快照\uff09').toMatch(/全日志实测|快照/);
  });

  it('⑥ 说明段也写覆盖面，且与表头一致', () => {
    const lines = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8').split('\n');
    const hi = lines.findIndex((l) => l.startsWith('| 闸 |'));
    const above = lines.slice(Math.max(0, hi - 10), hi).join('\n');
    expect(above).toMatch(/全日志实测|快照/);
  });
});
