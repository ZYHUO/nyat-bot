import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * interrupt 必须带 addressed 打标 + 分桶计数（round 177，计划 (b) 的观测半边）。
 *
 * 现场（2026-09-23 15:05）：3 条人类消息被推进同一个正在跑的任务，其中
 * "你看看在那个 状态检测那边" / "能不能重启 waro" / "warp*" 没 @ 也没回复 bot，
 * 只是群里闲聊——任务照样每条都回，于是一个任务 51 秒发了 4 次。
 *
 * k3 round 173 建议的治法 ((b) interrupt 分级) 是 prompt 语义改动，而目前没有
 * taskId 生产数据能验它——所以先只打标 + 计数，拿到分桶数据再决定要不要分级。
 */
describe('interrupt 的寻址打标', () => {
  const SRC = 'src/meta/session.ts';
  const MOD = 'src/agent/interrupts.ts';

  const block = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const i = lines.findIndex((l) => l.includes('addressed ?'));
    expect(i, '打标计数那块不在').toBeGreaterThan(-1);
    return lines.slice(Math.max(0, i - 16), i + 8).join('\n');
  };

  it('① AgentInterrupt 有 addressed 字段（可选，缺省=未知，不当成寻址）', () => {
    const s = fs.readFileSync(MOD, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.trim() === 'addressed?: boolean;')).toBe(true);
  });

  it('② 判据用全仓同一个寻址定义，不新造第二套', () => {
    const b = block();
    expect(b).toContain('getBotIdentity()');
    expect(b).toContain('@${ident.username}');
    expect(b).toContain('nicknames');
    expect(b).toContain('replyTo');
  });

  it('③ 判不出来的一律算未寻址（宁可少拦，不可误拦）', () => {
    const b = block();
    // addressed 只由 repliedTo || mentioned 决定，没有第三个"默认 true"的来源
    expect(b).toContain('const addressed = repliedTo || mentioned;');
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('addressed') && l.includes('|| true'))).toBe(false);
  });

  it('④ 两个分桶计数器（寻址 / 背景）', () => {
    const b = block();
    expect(b).toContain('agent_interrupt_addressed_total');
    expect(b).toContain('agent_interrupt_background_total');
  });

  it('⑤ 打标写进 pushInterrupt（不是只计数不传）', () => {
    const b = block();
    expect(b).toContain('addressed,');
    expect(b).toContain('pushInterrupt(agentTaskId');
  });

  it('⑥ 原有的「routed as interrupt」日志没被改掉', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('agent: message routed to running long task as interrupt');
  });
});
