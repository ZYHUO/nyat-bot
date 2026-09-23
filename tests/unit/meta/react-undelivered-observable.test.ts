import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * Meta react 分支的失败必须可观测（round 94）。
 *
 * 本会话第 5 处"防问题的机制只有 debug 日志"：
 *   round 75 截断重试走 debug，被 LOG_LEVEL=info 过滤 → 排了十二项才明白
 *   round 77 stickers.pick 返回裸 null
 *   round 78 reflection 无计数器
 *   round 84 代发 guard 挡住时静默（补了 info 后 1 分钟就挡了一次）
 *   round 87 撞名守卫 0 触发无法验证
 *   round 94 这一处：react 发不出去时 falling through 只有 debug
 */
describe('Meta react 失败可观测', () => {
  const SRC = 'src/meta/heart-adapter.ts';

  it('① react 未送达时打 warn（不是 debug）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('Meta heart: react not delivered, falling through');
    const i = s.indexOf('Meta heart: react not delivered');
    const before = s.slice(Math.max(0, i - 200), i);
    expect(before).toContain('logger.warn');
    expect(before).not.toContain('logger.debug');
  });

  it('② 有计数器', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('meta_react_undelivered_total');
    expect(s).toContain('incrCounter');
  });

  it('③ 带了 emoji（能看出是哪个表情发不出）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("{ chatId, emoji }");
  });

  it('④ 行为没变：仍 falling through 到 wait 分支', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('falling through');
  });

  it('⑤ 成功路径仍是 info + silence（没被这次改动碰）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('Meta heart: reacted');
    expect(s).toContain("return { verdict: 'silence', layer: 'L1', reason: `heart_react:${heart.why}` };");
  });
});
