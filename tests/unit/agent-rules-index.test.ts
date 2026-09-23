import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 80: AGENTS.md 的规矛要可枚举。
 *
 * Round 79 收尾说“计数器可枚举（grep incrCounter），规矛不可以”——
 * 而 round 78 刚刚证明缺席比抨贱难发现。这里给规矛一份索引守卫。
 *
 * 规矛分居两处：`## Writing Chinese` 里的三条粗体，
 * 和 `## Cross-checking` 里的 ### 节。两处都羗，否则缺席报出来的是 6。
 */

const SRC = 'AGENTS.md';

const collectRules = (): Array<{ title: string; body: string }> => {
  const text = fs.readFileSync(SRC, 'utf8');
  const lines0 = text.split('\n');
  const bold: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < lines0.length; i++) {
    const m = /^\*\*(\d)\. ([^*]+?)\*\*(?:\s|$)/.exec(lines0[i]!);
    if (!m) continue;
    let body = `${m[2]}\n`;
    // 粗体规则的正文是后续几段，到下一来粗体或二级节为止
    for (let k = i + 1; k < lines0.length; k++) {
      if (/^\*\*\d\.\s/.test(lines0[k]!) || lines0[k]!.startsWith('## ')) break;
      body += lines0[k] + '\n';
    }
    bold.push({ title: `rule ${m[1]}`, body });
  }
  const lines = text.split('\n');
  const sections: Array<{ title: string; body: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('### ')) {
      let body = '';
      for (let k = i + 1; k < lines.length && !lines[k]!.startsWith('## '); k++) body += lines[k] + '\n';
      sections.push({ title: lines[i]!.slice(4).trim(), body });
    }
  }
  return [...bold, ...sections];
};

describe('AGENTS.md 的规矛索引', () => {
  it('① 至少 9 条（3 粗体 + 6 节）——少于 9 就是有节被误删', () => {
    const rs = collectRules();
    expect(rs.length, `只有 ${rs.length} 条: ${rs.map((x) => x.title).join(' | ')}`).toBeGreaterThanOrEqual(9);
  });

  it('② 每条都有可执行形态（Rule:/Corollary/表格/命令/代码块/换番反例）', () => {
    // 判据是"读它一眼知道该干什么"：命令、表格、代码块、
    // 或者一个具体的错法反例（`...\n...`、ZZ_、等等）。
    const imperative = /never|always|do not|don't|must|write it|use |read it|name it|state/i;
    const weak = collectRules()
      .filter((x) => !/Rule:|Corollary|\*\*Q:|\*\*The rule|npm run|npx |tsx |git -|\*\*Rule/.test(x.body)
        && !x.body.includes('```') && !x.body.includes('| ')
        && !/`[^`]{6,}`/.test(x.body.slice(0, 400))
        && !imperative.test(x.title + ' ' + x.body.slice(0, 200)))
      .map((x) => x.title);
    expect(weak, '这些节没有可执行形态').toEqual([]);
  });

  it('③ 边界表标了实证/假设（round 77）', () => {
    const text = fs.readFileSync(SRC, 'utf8');
    expect(text).toContain('hypothesis, not a fact');
    expect(text).toContain('confirmed = r50/r51');
  });

  it('④ 本会话新增计数器名字至少在一份文档里（round 79 行动）', () => {
    const docs = ['AGENTS.md', 'docs/OBJECTIVE-STATUS.md', 'docs/plan-reply-behaviour.md', 'docs/voice-tuning.md']
      .map((f) => fs.readFileSync(f, 'utf8'));
    const must = ['send_task_burst_total', 'agent_interrupt_addressed_total', 'send_topic_word_repeat_total'];
    for (const c of must) {
      expect(docs.some((t) => t.includes(c)), `${c} 任何文档里都没有`).toBe(true);
    }
    // round 79 抛出来的两个实席：round 175/176 写进 known-issues 后这里就绿
    const known = fs.readFileSync('docs/known-issues.md', 'utf8');
    expect(known).toContain('llm_inflight_cap_skipped_total');
    expect(known).toContain('llm_short_cooldown_total');
  });
});
