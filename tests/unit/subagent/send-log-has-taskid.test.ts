import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 发送日志必须带 taskId（round 170，计划第 3a）。
 *
 * 之前 `host sendText` 不带 taskId，于是"一个任务发了几个气泡"这个
 * 对"说话太应激"最直接的指标，从日志里**算不出来**——只能按时间窗近似
 * （round 106 那么干过，结论混了不同任务）。
 */
describe('发送日志带 taskId', () => {
  const SRC = 'src/subagent/host-api.ts';

  it('① host sendText 与 continuation 两条都带', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(lines.filter((l) => l.includes("taskId: opts.taskId ?? null")).length).toBeGreaterThanOrEqual(2);
  });

  it('② 在 logger.info 的参数字面量里（不是别处的同名变量）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n');
    const logIdx = lines.findIndex((l) => l.includes("'host sendText'"));
    expect(logIdx).toBeGreaterThan(-1);
    // 往上找最近的 logger.info，taskId 应在它和 msg 之间
    let open = -1;
    for (let i = logIdx - 1; i >= 0; i--) {
      if (lines[i]!.includes('logger.info(')) { open = i; break; }
      if (lines[i]!.trim() === '{') { open = i - 1; break; }
    }
    expect(open).toBeGreaterThan(-1);
    expect(lines.slice(open, logIdx + 1).join('\n')).toContain('taskId: opts.taskId');
  });

  it('③ 有长注释解释为什么它重要（否则下一个人当冗余字段删掉）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 170（计划第 3a）');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 700);
    // 注释要说出三件事：缺它时什么算不出、round 106 的做法为什么不够、
    // 以及 legacy/failsafe 两边都不记这个事实
    expect(block).toContain('算不出来');
    expect(block).toContain('round 106');
    expect(block).toContain('legacy');
  });

  it('④ 两个日志点都记 ?? null（不是裸 opts.taskId，pino 会吞 undefined 字段）', () => {
    // round 142 的教训：只查这两个日志点的邻域，别查全文件——
    // 仓里另有 9 处 `taskId: opts.taskId,`（emitTaskRuntimeEvent 之类的调用），
    // 查全文件会把无关的旧代码一起判红。
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n');
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter((x) => ["'host sendText'", "'host sendText continuation'"].some((m) => x.l.includes(m)))
      .map((x) => x.i);
    expect(sites.length).toBe(2);
    for (const site of sites) {
      const region = lines.slice(Math.max(0, site - 14), site + 1).join('\n');
      expect(region).toContain('taskId: opts.taskId ?? null');
      expect(region).not.toMatch(/taskId: opts\.taskId\s*,/);
    }
  });
});
