import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 代发的"目标不在群"守卫必须可数（round 84）。
 *
 * round 55 加了这个检查（当时实测 5/6 的代发目标不在群里，
 * 38 次代发无回执的由来）。但**成功/静默路径没有任何观测**——
 * 只有 fail-open（网络查不到）时走 debug。
 *
 * 于是无法区分三种 corrective action 完全不同的情况：
 *
 *   挡掉了（guard 在工作）     → 不用管
 *   发了但没人接（bot 不在群）→ 要修 guard
 *   没被调用（代码没接上）     → 要接线
 *
 * 这一家族这个会话犯了四次：
 *   round 75 截断重试走 debug，被 LOG_LEVEL=info 过滤
 *   round 77 stickers.pick 返回裸 null
 *   round 78 reflection 和心流共账号（无计数器）
 *   round 84 代发 guard 静默
 */
describe('代发 guard 的可观测性', () => {
  const SRC = 'src/pipeline/tools/bot-delegation.ts';

  it('① 挡住时打 info（不是 debug——那会被 LOG_LEVEL=info 过滤）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('delegation: target bot not in chat — blocked');
    // 那条日志必须是 logger.info
    const i = s.indexOf('delegation: target bot not in chat');
    const before = s.slice(Math.max(0, i - 200), i);
    expect(before).toContain('logger.info');
  });

  it('② 有计数器（能看出是普遍还是个别 bot）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('delegation_target_absent_total');
    expect(s).toContain('incrCounter');
  });

  it('③ 带了 chat 维度（哪个群在反复试不在场的 bot）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toMatch(/incrCounter\('delegation_target_absent_total', \{ chat: chatId \}\)/);
  });

  it('④ 守卫本身还在（返回 sent:false + 给人话）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('不在这个群里,代发了也没人接');
    expect(s).toContain('return { sent: false');
  });

  it('⑤ fail-open 仍是 debug（那个不需要吵）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("logger.debug({ chatId, botName }, 'delegation: target-in-chat check failed, fail-open')");
  });
});
