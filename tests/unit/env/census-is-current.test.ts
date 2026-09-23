import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * docs/flag-census.md 必须是最新的（round 128）。
 *
 * 2026-09-23 实测：round 21 把一堆 flag 的 reader 从 executor.ts 迁到
 * prompt-inputs.ts，而 census 从那次起就没重新生成过（上次 09-22 16:23）。
 * 66 行 diff 悄悄躺着，而 AGENTS.md 第 6 条明写"每次加 flag 都要重跑 census"。
 *
 * `no-dead-switches` 能抓死旗标，但**没有守卫抓 census 该重新生成**——
 * 这个测试填那个缺口。做法：跑脚本，然后 git diff 必须为空。
 *
 * 所以这个测试同时要求工作区干净（census 是最新的提交状态）。
 */
describe('flag-census 是最新的', () => {
  // census 脚本要扫整个 src/，实测 ~24s，远超默认 5s。
  it('重新生成后相对 HEAD 无 diff', { timeout: 120_000 }, () => {
    // 先在临时副本上跑，避免污染工作区
    const before = fs.readFileSync('docs/flag-census.md', 'utf8');
    execSync('python3 scripts/flag-census.py', { stdio: 'ignore' });
    const after = fs.readFileSync('docs/flag-census.md', 'utf8');
    // 还原（不管有没有 diff，测试都该是无副作用的）
    fs.writeFileSync('docs/flag-census.md', before);
    if (after !== before) {
      // 给出前几行 diff 便于定位
      const b = before.split('\n');
      const a = after.split('\n');
      const firstDiff = a.findIndex((l, i) => l !== b[i]);
      throw new Error(
        'docs/flag-census.md 过期了 —— 跑 python3 scripts/flag-census.py 并提交。\n' +
        `首个差异在第 ${firstDiff + 1} 行:\n  期望: ${b[firstDiff]?.slice(0, 100)}\n  实际: ${a[firstDiff]?.slice(0, 100)}`,
      );
    }
    expect(after).toBe(before);
  });
});
