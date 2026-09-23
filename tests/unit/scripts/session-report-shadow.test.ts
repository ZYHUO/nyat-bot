import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * session-report 必须数影子决策的收支（round 181）。
 *
 * Round 149 量出影子决策是 `All labels exhausted` 的第 2 大报错方
 * （2772 次 THREW，仅次于心流 2699），而 session-report 里 grep 'shadow'
 * 是 **0 次**——它一直是个没有仪表盘的 LLM 消费者。
 *
 * 而它是纯观测（k3：shadow 且爆了 → 照发，只观测），每崩一次就白烧一次 LLM，
 * 在链已经 exhausted 的时候就是在跟心流抢额度。
 */
describe('session-report 的影子决策收支', () => {
  const SRC = 'scripts/session-report.mts';

  it('① 采集 THREW 和 core shadow compare 两条', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes("msg === 'shadow decision THREW (counted as silent)'"))).toBe(true);
    expect(code.some((l) => l.includes("msg === 'core shadow compare'"))).toBe(true);
  });

  it('② 输出带"崩的比成的多"判据（AGENTS.md 的 ⚠️ 形状）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('影子决策 比较成功/崩掉');
    expect(s).toContain('shadowThrew > st.shadowCompared');
    expect(s).toContain('纯观测在白烧链上额度');
  });

  it('③ 两处注释都说明为什么它重要（否则下一个人当无关行删掉）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 字段声明处：交代这个数从哪来、以及它此前没有仪表盘
    const fieldComment = s.slice(
      s.indexOf('round 181：影子决策的收支'),
      s.indexOf('shadowThrew: number;'),
    );
    expect(fieldComment).toContain('round 149');
    expect(fieldComment).toContain('没有仪表盘');
    // 输出行处：交代为什么要单独看它
    const outComment = s.slice(
      s.indexOf('round 181：影子决策。THREW'),
      s.indexOf('console.log(`  影子决策 比较成功/崩掉'),
    );
    expect(outComment).toContain('纯观测');
    expect(outComment).toContain('白烧');
  });

  it('④ 输出在心流健康那节里（不是孤岛）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const health = s.indexOf('── 2. 心流健康 ──');
    const shadow = s.indexOf('影子决策 比较成功/崩掉');
    expect(health).toBeGreaterThan(-1);
    expect(shadow).toBeGreaterThan(health);
  });
});
