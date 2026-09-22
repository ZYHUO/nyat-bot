import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * heart.md 必须同时给出**接**和**不接**两种可执行判据，且必须真的描述 wait。
 *
 * 2026-09-22 round 3（用户："bot 还是太爱说话了"）。
 * 全量日志实测（40,083 条入站）：
 *   heart act=reply  11%(09-16) → 45%(09-22)   ← 四倍
 *   heart act=wait   0-6 次/天（约 2000 次裁决里）← 中间档形同不存在
 *
 * 病因在 prompt 本身：原文写"别把 pass 当成安全选项：想接就接"，
 * 并且 wait 只定义了"对方话说一半"一种情形。等于明确鼓励多说，
 * 且没有中间档——要么抢话，要么装没看见。
 *
 * 这条测试锁住新结构的三个条件，防止它悄悄漂回去。
 * 为什么值得测试：这是**产品行为的主要控制面**，而它是个 markdown 文件——
 * 没有类型检查、没有编译错误会提醒你把它改坏了。
 */
const md = readFileSync('prompts/task/heart.md', 'utf8');

describe('heart prompt 的说话节制结构', () => {
  it('① 有占比门槛，且高占位默认不接', () => {
    // 必须让模型先看自己这一波占了多少
    expect(md).toMatch(/占比\s*≥\s*30%/);
    expect(md).toMatch(/默认不接|先放一放/);
  });

  it('② wait 是三种选择里被真正描述的那个（不是只提一次）', () => {
    expect(md).toMatch(/### wait/);
    // 至少三种 wait 情形 + 和 pass 的区别
    expect(md.match(/连发中|逗号结尾|话说一半|正在展开|气还没落地/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(md).toMatch(/wait 和 pass 的区别/);
  });

  it('③ 明确说"爱说话和话多是两回事"（而不是"别把 pass 当安全选项"）', () => {
    expect(md).toMatch(/爱说话.*和.*话多.*是两回事|话多.*是两回事/);
    // 旧的那句话不能回来
    expect(md).not.toMatch(/别把 pass 当成安全选项/);
  });

  it('④ 点名你的永远不许 pass 这条铁律还在（防过度收紧）', () => {
    expect(md).toMatch(/点名你的.*永远不许 pass|永远不许 pass/);
  });

  it('⑤ 三个判据关卡的顺序写明了（先看自己，再看消息）', () => {
    expect(md).toMatch(/第一关/);
    expect(md).toMatch(/第二关/);
    expect(md).toMatch(/第三关/);
  });
});
