import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 推理模型的下限必须够用（round 72）。
 *
 * 2026-09-23。`src/ai/provider.ts` 有一道下限：已知会截断的 label，
 * max_tokens 一律抬到 REASONING_TOKEN_FLOOR。这是**一次覆盖 20+ 个调用点**的
 * 系统性解法——那些点多数是故意的（draft-selector 20 = "挑一个"），
 * 逐个改既改不全也会把故意改大。
 *
 * 但下限本身的值过期了：注释写"1200 是实测值（短 prompt 上约 840 token）"，
 * 而生产实测（09-23）：
 *
 *   maxTokens=1200  outputTokens=1200   ← 1200 不够
 *   maxTokens=2400  outputTokens=2400   ← 2400 也不够
 *   maxTokens=8192  outputTokens=8192   ← 长 prompt 上连 8192 都被吃光
 *
 * 且这个下限是反应式的（进程内记忆，label 要先截断一次才学会），
 * 所以每次重启都重新交一遍学费。
 */
describe('REASONING_TOKEN_FLOOR', () => {
  it('① 下限 >= 4000（生产实测 1200/2400 都不够）', () => {
    const s = fs.readFileSync('src/ai/provider.ts', 'utf8');
    const m = s.match(/const REASONING_TOKEN_FLOOR = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(4000);
  });

  it('② 下限不超过 32000 上限（retry 那行的 Math.min 边界不能反了）', () => {
    const s = fs.readFileSync('src/ai/provider.ts', 'utf8');
    const m = s.match(/const REASONING_TOKEN_FLOOR = (\d+);/);
    expect(Number(m![1])).toBeLessThanOrEqual(32000);
    // retry 那行是 Math.min(Math.max(budget*2, FLOOR), 32000)
    // floor 超过 32000 会让 min 永远取 floor，边界反了
    expect(s).toContain('Math.min(Math.max(budget * 2, REASONING_TOKEN_FLOOR), 32_000)');
  });

  it('③ 它是阈值型常量而不是逐点硬编码（20+ 个故意小的调用点不动）', () => {
    // 这条锁住"别把下限删了改成逐个改调用点"——那条路改不全。
    const s = fs.readFileSync('src/ai/provider.ts', 'utf8');
    expect(s).toContain('const truncatingLabels = new Set<string>();');
    expect(s).toContain('const budget = needsFloor ? Math.max(asked, REASONING_TOKEN_FLOOR) : asked;');
  });
});
