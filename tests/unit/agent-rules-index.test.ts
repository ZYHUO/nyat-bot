import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 87: **AGENTS.md 的结构守卫**——round 86 屏遣这个错的方式。
 *
 * Round 86 我在 anchor 后面追加一段，而 anchor 自身尾部那句
 * 被原样留下——成了重复行。那就是 round 47 抓过的
 * "同一份内容两处拳选" 的小型复发；上一次是脚本输出与文档，
 * 这一次是同一个文件里面两行。
 *
 * 为什么要守卫：AGENTS.md 里每句规矛都会被执行。一句话出现两次，
 * 下一个人修其中一处就会认为它变了——而另一处还在说旧的。
 * round 198 的两个 SECTION_ORDER 就是这么让修复失效了六轮。
 *
 * 但不能一律禁止重复：表格里的单元格\uff08`| x | y |`\uff09、代码块里的行、
 * 以及短行都能合法地重复。所以只查**非代码块、非表格、超过 40 字节的正文行**。
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

describe('AGENTS.md 的 markdown 配对（round 156/157）', () => {
  it('粗体标记 ** 总数为偶（round 156 我插入时吃掉过一个）', () => {
    const text = fs.readFileSync('AGENTS.md', 'utf8');
    const n = (text.match(/\*\*/g) ?? []).length;
    expect(n % 2, `** 出现 ${n} 次（奇数 = 有一个粗体没闭合）`).toBe(0);
  });

  it('没有 **** （两个粗体撞在一起的痕迹）', () => {
    const text = fs.readFileSync('AGENTS.md', 'utf8');
    const hits = text.split('\n').filter((l) => l.includes('****')).length;
    expect(hits, `有 ${hits} 行含 ****（插入时和锚点行首的 ** 撞了）`).toBe(0);
  });

  /** round 158: 行内代码里的 | 不是分隔符。round 157 第一版数原始管道，
   *  拿到 voice-tuning.md 上会假红（`split('|')` 和 `\| round NN \|` 都在行内代码里）。
   *  先剥掉行内代码再数——这正是 round 144 那条：判据形状要比损伤形状精确。 */
  const stripInlineCode = (l: string): string => l.replace(/`[^`]*`/g, 'X');

  const tableBlocksOf = (file: string): Array<{ head: string; pipes: number[] }> => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const out: Array<{ head: string; pipes: number[] }> = [];
    let cur: number[] = [];
    let head = '';
    let inFence = false;
    const flush = (): void => {
      if (cur.length >= 2 && new Set(cur).size > 1) out.push({ head, pipes: [...cur] });
      cur = [];
    };
    for (const l of lines) {
      if (l.trimStart().startsWith('```')) { inFence = !inFence; continue; }
      if (inFence) continue;
      if (l.startsWith('|')) {
        const n = stripInlineCode(l).split('|').length;
        if (cur.length === 0) head = l.slice(0, 40);
        cur.push(n);
      } else flush();
    }
    flush();
    return out;
  };

  it('每个连续表格块内各行管道数一致（round 157：表格断行会静默错位）', () => {
    const bad = tableBlocksOf('AGENTS.md')
      .map((b) => `AGENTS.md 块头「${b.head}」管道数 ${b.pipes.join('/')}`);
    expect(bad, '这些表格块内行列数不一致：\n  ' + bad.join('\n  ')).toEqual([]);
  });

  it('voice-tuning.md 同样查（round 158：它才是我主要写字的地方，6800+ 行）', () => {
    const bad = tableBlocksOf('docs/voice-tuning.md')
      .map((b) => `voice-tuning.md 块头「${b.head}」管道数 ${b.pipes.join('/')}`);
    expect(bad, '这些表格块内行列数不一致：\n  ' + bad.join('\n  ')).toEqual([]);
  });
});

describe('voice-tuning.md 的标题结构（round 159 手工查过，round 160 立守卫）', () => {
  const headingsOf = (file: string): Array<{ level: number; line: number; text: string }> => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const out: Array<{ level: number; line: number; text: string }> = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trimStart().startsWith('```')) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = /^(#{1,6}) (.+)$/.exec(l);
      if (m) out.push({ level: m[1]!.length, line: i + 1, text: m[2]! });
    }
    return out;
  };

  it('标题层级不跳跃（H2 直接跳到 H4）', () => {
    const bad: string[] = [];
    let prev = 0;
    for (const h of headingsOf('docs/voice-tuning.md')) {
      if (prev && h.level > prev + 1) bad.push(`L${h.line} H${prev}→H${h.level}「${h.text.slice(0, 30)}」`);
      prev = h.level;
    }
    expect(bad, '这些标题跳过了层级：\n  ' + bad.join('\n  ')).toEqual([]);
  });

  it('没有重复的 ## 节标题（round 160：只查 H2——H3 是结构性标签）', () => {
    // round 160: 第一版查所有层级，被「结论」「教训」「后果」这类
    // 结构性 H3 标签误伤（它们在不同轮次里合法重复）。
    // round 47 那个病是"同一结论写两遍"——那对应 H2（每轮的结论节）。
    const seen = new Map<string, number>();
    const bad: string[] = [];
    for (const h of headingsOf('docs/voice-tuning.md')) {
      if (h.level !== 2) continue;
      const t = h.text.trim();
      if (seen.has(t)) bad.push(`L${seen.get(t)} 与 L${h.line}：「${t.slice(0, 40)}」`);
      else seen.set(t, h.line);
    }
    expect(bad, '这些 ## 节标题出现了两次：\n  ' + bad.join('\n  ')).toEqual([]);
  });

  it('没有空节（有标题没内容，round 160 修正了边界）', () => {
    // round 160: 第一版用"到下一个标题（任意层级）"算 body，
    // 于是「## X」紧跟「### Y」被判成空节。真实边界是
    // 下一个**同级或更高级**标题。
    const lines = fs.readFileSync('docs/voice-tuning.md', 'utf8').split('\n');
    const hs = headingsOf('docs/voice-tuning.md');
    const bad: string[] = [];
    for (let k = 0; k < hs.length; k++) {
      const cur = hs[k]!;
      let to = lines.length;
      for (let j = k + 1; j < hs.length; j++) {
        if (hs[j]!.level <= cur.level) { to = hs[j]!.line - 1; break; }
      }
      const body = lines.slice(cur.line, to).filter((l) => l.trim() !== '');
      if (body.length === 0) bad.push(`L${cur.line}「${cur.text.slice(0, 40)}」`);
    }
    expect(bad, '这些标题下没有内容：\n  ' + bad.join('\n  ')).toEqual([]);
  });
});
