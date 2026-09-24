import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 122: **known-issues 里每个问题必须有归属**。**
 *
 * Round 121 立了"分清没想到和验不了"。这轮拿它寡我自己立的规矛：
 * 11 条里 6 条是纯纪律，而其中一条（"已知问题要排期"）**其实验得了**——
 * 我把它当纯纪律放了 40 轮（round 84 才发现）。
 *
 * 判据：known-issues.md 里每个 `### ` 节要么写了哪轮处理（round NN），
 * 要么写了触发器——否则它就是 round 84 那个"已知"，
 * 而"已知"是会被无限期推缧的状态名（没有任何东西指向它）。
 *
 * **边界**（round 113 同款）：“已修”“已残役”“结论”这类历史小节天然没有待排期＠14
 * 它们的归属就是"已经不是问题了"。**禁的是歧形：既没轮次、没触发器、也没说已经关闭。**
 */

const SRC = 'docs/known-issues.md';

const sections = (): Array<{ title: string; body: string }> => {
  const raw = fs.readFileSync(SRC, 'utf8').split('\n');
  const out: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i]!.startsWith('### ')) continue;
    let body = '';
    for (let k = i + 1; k < raw.length && !raw[k]!.startsWith('## '); k++) body += raw[k] + '\n';
    out.push({ title: raw[i]!.slice(4), body });
  }
  return out;
};

describe('known-issues 每个问题都有归属', () => {
  it('① 至少有 5 个问题节（少于这个说明有节被误删）', () => {
    expect(sections().length).toBeGreaterThanOrEqual(5);
  });

  it('② 每节要么有 round 编号、要么有待排期+触发器', () => {
    const orphans = sections()
      .filter((x) => !/round \d+/.test(x.body))
      .filter((x) => !/待排期/.test(x.body))
      .map((x) => x.title.slice(0, 50));
    expect(orphans, '这些问题没轮次也没排期（round 84 那种"已知"）：\n  ' + orphans.join('\n  ')).toEqual([]);
  });

  it('③ "待排期"必须带触发器（不能只说待排期）', () => {
    const vague = sections()
      .filter((x) => /待排期/.test(x.body) && !/round \d+/.test(x.body))
      .filter((x) => !/触发|等到|若干|条件/.test(x.body))
      .map((x) => x.title.slice(0, 50));
    expect(vague, '这些只说了“待排期”没说什么时候动手：\n  ' + vague.join('\n  ')).toEqual([]);
  });

  it('④ 已关闭的节要明说（否则下一个人会重开它）', () => {
    // 不要求"必须有"，但检查带的：如果一节同时没有轮次和排期，
    // 那它必须是已关闭类。②③ 已经覆盖了，这条查的是反向——
    // 已修的节不得再写"待排期"。
    const both = sections()
      .filter((x) => /已修|已残役|结论/.test(x.title) && /待排期/.test(x.body))
      .map((x) => x.title.slice(0, 50));
    expect(both, '这些已关闭的节还写着待排期：\n  ' + both.join('\n  ')).toEqual([]);
  });
});
