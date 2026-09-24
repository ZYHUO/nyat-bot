import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 87: **AGENTS.md \u7684\u7ed3\u6784\u5b88\u536b**\u2014\u2014round 86 \u5c4f\u9063\u8fd9\u4e2a\u9519\u7684\u65b9\u5f0f\u3002
 *
 * Round 86 \u6211\u5728 anchor \u540e\u9762\u8ffd\u52a0\u4e00\u6bb5\uff0c\u800c anchor \u81ea\u8eab\u5c3e\u90e8\u90a3\u53e5
 * \u88ab\u539f\u6837\u7559\u4e0b\u2014\u2014\u6210\u4e86\u91cd\u590d\u884c\u3002\u90a3\u5c31\u662f round 47 \u6293\u8fc7\u7684
 * "\u540c\u4e00\u4efd\u5185\u5bb9\u4e24\u5904\u62f3\u9009" \u7684\u5c0f\u578b\u590d\u53d1\uff1b\u4e0a\u4e00\u6b21\u662f\u811a\u672c\u8f93\u51fa\u4e0e\u6587\u6863\uff0c
 * \u8fd9\u4e00\u6b21\u662f\u540c\u4e00\u4e2a\u6587\u4ef6\u91cc\u9762\u4e24\u884c\u3002
 *
 * \u4e3a\u4ec0\u4e48\u8981\u5b88\u536b\uff1aAGENTS.md \u91cc\u6bcf\u53e5\u89c4\u77db\u90fd\u4f1a\u88ab\u6267\u884c\u3002\u4e00\u53e5\u8bdd\u51fa\u73b0\u4e24\u6b21\uff0c
 * \u4e0b\u4e00\u4e2a\u4eba\u4fee\u5176\u4e2d\u4e00\u5904\u5c31\u4f1a\u8ba4\u4e3a\u5b83\u53d8\u4e86\u2014\u2014\u800c\u53e6\u4e00\u5904\u8fd8\u5728\u8bf4\u65e7\u7684\u3002
 * round 198 \u7684\u4e24\u4e2a SECTION_ORDER \u5c31\u662f\u8fd9\u4e48\u8ba9\u4fee\u590d\u5931\u6548\u4e86\u516d\u8f6e\u3002
 *
 * \u4f46\u4e0d\u80fd\u4e00\u5f8b\u7981\u6b62\u91cd\u590d\uff1a\u8868\u683c\u91cc\u7684\u5355\u5143\u683c\uff08`| x | y |`\uff09\u3001\u4ee3\u7801\u5757\u91cc\u7684\u884c\u3001
 * \u4ee5\u53ca\u77ed\u884c\u90fd\u80fd\u5408\u6cd5\u5730\u91cd\u590d\u3002\u6240\u4ee5\u53ea\u67e5**\u975e\u4ee3\u7801\u5757\u3001\u975e\u8868\u683c\u3001\u8d85\u8fc7 40 \u5b57\u8282\u7684\u6b63\u6587\u884c**\u3002
 */

const SRC = 'AGENTS.md';

// round 88: 拉宽到四份。Round 87 只覆盖了 AGENTS.md，而那三份
// 同样每轮被读（它们是我的"结论形式"）。实测四份都没有重复行，
// 但不要因为现在干净就不守——round 86 那个错也是一时的。
const ALL_DOCS = ['AGENTS.md', 'docs/OBJECTIVE-STATUS.md', 'docs/known-issues.md',
  'docs/plan-reply-behaviour.md', 'docs/voice-tuning.md'];

const bodyLines = (file = SRC): string[] => {
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  let inFence = false;
  const out: string[] = [];
  for (const l of raw) {
    if (l.trimStart().startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (l.startsWith('|')) continue;              // 表格单元格合法重复
    if (l.trim() === '') continue;
    out.push(l);
  }
  return out;
};

describe('AGENTS.md 结构', () => {
  it('① 至少 9 条规矩（3 粗体 + 6 节）——round 80 立的', () => {
    const text = fs.readFileSync(SRC, 'utf8');
    const bold = [...text.matchAll(/^\*\*(\d)\. ([^*]+?)\*\*(?:\s|$)/gm)].length;
    const secs = [...text.matchAll(/^### /gm)].length;
    expect(bold + secs, `粗体 ${bold} + 节 ${secs}`).toBeGreaterThanOrEqual(9);
  });

  it('② 五份文档都没有超过 40 字节的重复正文行', () => {
    const seen = new Map<string, number>();
    const dups: string[] = [];
    for (const l of bodyLines()) {
      if (Buffer.byteLength(l) < 40) continue;      // 短行合法重复
      const n = seen.get(l) ?? 0;
      seen.set(l, n + 1);
      if (n === 1) dups.push(l.trim().slice(0, 60));
    }
    expect(dups, '这些长行出现了两次：\n  ' + dups.join('\n  ')).toEqual([]);
  });

  it('②b 也没有"部分重复"——round 143 被这条救了（②只比整行）', () => {
    // round 143: 我插入时 anchor 是一个超过一行的句子，执行残留被留下——
    // 它和原行不相等（一个完整、一个只是尾部），所以 ② 比整行比不出来。
    // 形状判据：**某行是另一个更长行的严格后缀**。这个形状几乎不会有合法情况
    // （否则只检查"句子重复"，那会误伤合法引用——如 scripts/tamper-audit 被两条规矩提到）。
    const bodies = bodyLines();
    const bad: string[] = [];
    for (const l of bodies) {
      const t = l.trimEnd();
      if (Buffer.byteLength(t) < 20) continue;
      const longer = bodies.filter((o) => o !== l && o.endsWith(t) && o.length > t.length);
      if (longer.length) bad.push(t.slice(0, 60));
    }
    expect(bad, '这些行是另一行的尾部剧情（round 143 那种残留）:\n  ' + bad.join('\n  ')).toEqual([]);
  });


  it('③ 另四份也没有重复长行（round 88 拉宽）', () => {
    for (const f of ALL_DOCS.slice(1)) {
      const seen = new Map<string, number>();
      const dups: string[] = [];
      for (const l of bodyLines(f)) {
        if (Buffer.byteLength(l) < 40) continue;
        const n = seen.get(l) ?? 0;
        seen.set(l, n + 1);
        if (n === 1) dups.push(l.trim().slice(0, 50));
      }
      expect(dups, `${f} 里这些行出现了两次：\n  ` + dups.join('\n  ')).toEqual([]);
    }
  });

  it('③ 边界表标了实证/假设（round 77）', () => {
    const text = fs.readFileSync(SRC, 'utf8');
    expect(text).toContain('hypothesis, not a fact');
  });

  it('④ 排期规矩在（round 86）', () => {
    const text = fs.readFileSync(SRC, 'utf8');
    expect(text).toContain('never got a round number');
    expect(text).toContain('待排期');
  });

  it('⑤ 计数器名可检索（round 79/80）', () => {
    const docs = ['AGENTS.md', 'docs/OBJECTIVE-STATUS.md', 'docs/known-issues.md']
      .map((f) => fs.readFileSync(f, 'utf8'));
    for (const c of ['send_task_burst_total', 'llm_inflight_cap_skipped_total',
      'llm_short_cooldown_total', 'send_topic_word_repeat_total']) {
      expect(docs.some((t) => t.includes(c)), `${c} 缺席`).toBe(true);
    }
  });
});
