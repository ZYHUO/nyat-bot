import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * stickers.pick 的失败必须可诊断（round 77）。
 *
 * 2026-09-23。实测 09-22/23：53 次 `host sendSticker rejected bad fileId`，
 * fileId 全是空串。链条：
 *
 *   prompt: "先 stickers.pick(mood) 拿贴纸再 telegram.sendSticker"
 *   → pick 失口返回 **null**
 *   → 模型把 null 当 fileId 传下去
 *   → `String(null ?? '') === ''`
 *   → 守卫拦下（工作正常，没崩）
 *
 * 但贴纸没发出去——它的情绪出口少了一次。而日志只有一条
 * "fileId 不对"，没人知道根因是 pick 空了。
 *
 * **和 round 75 同一个病：失败长得不像失败。**
 * 那次的解是"把待诊断事件从会被过滤的日志级别上拿开"；
 * 这次的解是"别返回裸 null，返回一句人能看懂的原因"。
 */
describe('stickers.pick 的可诊断性', () => {
  const SRC = 'src/subagent/host-api.ts';

  it('① 不再 return null（null 会让模型当 fileId 传下去）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('async pick(mood');
    expect(i).toBeGreaterThan(-1);
    const seg = s.slice(i, i + 1200);
    expect(seg).not.toContain('return null');
  });

  it('② 空 mood / 无候选 / 库失败三种都说人话', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('mood 是空的');
    expect(s).toContain('这个情绪的库存是空的');
    expect(s).toContain('贴纸查找失败');
  });

  it('③ 有计数（能看出是普遍库存空还是个别 mood）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('sticker_pick_empty_total');
  });

  it('④ 成功路径仍返回 fileId（不是包一层对象）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('return cands[0]!.fileId;');
  });

  it('⑤ sendSticker 的守卫还在（空 fileId 仍要被拦）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('host sendSticker rejected bad fileId');
  });
});
