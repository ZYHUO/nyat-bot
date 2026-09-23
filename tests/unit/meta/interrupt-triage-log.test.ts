import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 92: **\u5206\u6876\u8981\u6709\u65e5\u5fd7\u884c\uff0c\u4e0d\u80fd\u53ea\u6709 counter\u3002**
 *
 * Round 91 \u5b9e\u6d4b\uff1a`agent_interrupt_addressed_total=3` / `background=6`
 * \u5728 /metrics \u91cc\u786e\u5b9e\u6709\u503c\uff0c\u4f46 `grep "interrupt triage" logs/app.log` = 0 \u884c\u3002
 *
 * \u539f\u56e0\uff1around 177 \u53ea\u5728\u90a3\u4e2a dispatch \u70b9\u8c03\u4e86 incrCounter\uff0c**\u6ca1\u6253\u65e5\u5fd7**\u3002\u800c
 * counter \u662f\u8fdb\u7a0b\u5185\u7684\uff08round 73 banner \u5199\u7740\u91cd\u542f\u5f52\u96f6\uff09\u2014\u2014\u91cd\u542f\u540e\u4e00\u5207\u5747\u8868\u3002
 *
 * \u8fd9\u5c31\u662f round 63/64 \u5f00\u59cb\u5f52\u7684\u90a3\u4e2a\u5751\u7684\u7b2c 5 \u6b21\uff08
 * debug \u7ea7\u4e0d\u53ef\u89c1 / \u5b57\u6bb5\u4e0d\u5bf9 / \u8c03\u7528\u70b9\u6ca1\u63a5\u4e0a / \u5199\u8fdb\u53bb\u4e86\u4f46\u6ca1\u65e5\u5fd7\uff09\u3002
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
