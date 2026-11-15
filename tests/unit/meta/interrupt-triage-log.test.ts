import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 92: **分桶要有日志行，不能只有 counter。**
 *
 * Round 91 实测：`agent_interrupt_addressed_total=3` / `background=6`
 * 在 /metrics 里确实有值，但 `grep "interrupt triage" logs/app.log` = 0 行。
 *
 * 原因：round 177 只在那个 dispatch 点调了 incrCounter，**没打日志**。而
 * counter 是进程内的\uff08round 73 banner 写着重启归零\uff09——重启后一切均表。
 *
 * 这就是 round 63/64 开始归的那个坑的第 5 次\uff08
 * debug 级不可见 / 字段不对 / 调用点没接上 / 写进去了但没日志\uff09。
 */

const SRC = 'src/meta/session.ts';

describe('interrupt 分桶有日志行', () => {
  const code = (): string[] => {
    const s = fs.readFileSync(SRC, 'utf8');
    return s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
  };

  it('① 同一个分支里既有 incrCounter 也有 logger.info（不是只有一个）', () => {
    const c = code();
    const ci = c.findIndex((l) => l.includes('agent_interrupt_addressed_total'));
    expect(ci, '计数器不在').toBeGreaterThan(-1);
    const after = c.slice(ci, ci + 20).join('\n');
    expect(after).toContain('logger.info');
  });

  it('② 日志 msg 区分 addressed/background 两种桶', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('agent interrupt triage: addressed');
    expect(s).toContain('agent interrupt triage: background');
  });

  it('③ 日志带 chatId + bucket 字段（口径要能单独 grep）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('agent interrupt triage: addressed');
    const before = s.slice(Math.max(0, i - 400), i);
    expect(before).toContain('chatId');
    expect(before).toContain('bucket:');
  });

  it('④ msg 名稳定（log:count / session-report 要能 grep 到）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 两个 msg 都必须以 agent interrupt triage: 开头，形状一致
    const ms = [...s.matchAll(/'agent interrupt triage: ([a-z]+)/g)].map((m) => m[1]);
    expect(ms).toContain('addressed');
    expect(ms).toContain('background');
  });

  it('⑤ 写在未被注释的行（round 53 rule 1）', () => {
    const c = code();
    expect(c.some((l) => l.includes('agent interrupt triage: addressed'))).toBe(true);
    expect(c.some((l) => l.includes('agent interrupt triage: background'))).toBe(true);
  });
});
