import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 文档里引用的文件必须存在。
 *
 * 2026-09-22 round 11。写 docs/code-tour.md 时我自己踩了一次：
 * "想改它话太多 → 看 docs/voice-tuning.md"，而那个文件当时**不存在**。
 * 我是靠 grep 自己引用的路径才发现——但那时候已经写完了。
 *
 * 这正是这个仓库自己的规矩说的那件事：CONTRIBUTING.md 第 3 条
 * "If README or a comment says something runs, it should actually run.
 *  The whole v1.1 audit cycle existed because seven things were advertised
 *  that didn't match reality."
 *
 * 文档虚标比没有文档更糟：读者会照着走，然后怀疑自己。
 * 这条测试把"引用了"和"存在了"绑在一起。
 */
/**
 * 只查这几篇。
 *
 * **不含 README.md**，这是有意的：README 的项目结构段是一棵 `src/` 目录树，
 * 里面写 `meta/ingress-intercepts.ts` 在那张图的上下文里是对的（图就画在 src/ 下），
 * 按仓库根解析必然判不存在。它还有大量正文行内代码（`chats.find`、`frame.ts`、
 * `deploy-report.txt`——后者是日志路径不是源码路径）。
 *
 * 硬把 README 塞进来的话，要么正则越来越复杂去猜意图，要么有一堆误报——
 * 误报的测试等于没有测试，最后会被整个关掉。
 *
 * 这几篇是我用"反引号 = 路径引用"这一种风格写的，正则能可靠地判。
 * 换了风格就要重新校准正则——所以下面有一条"至少解析到一个"的断言守着它。
 */
const DOCS = ['docs/code-tour.md', 'docs/voice-tuning.md', 'docs/skills.md', 'CONTRIBUTING.md'];

/**
 * 抠出 markdown 里反引号包着的路径引用。
 *
 * 两种都收：带目录的相对路径（`src/x/y.ts`）和表格里的裸文件名（`humanizer.ts`）。
 * 裸文件名**也是承诺**——表格里写 "humanizer.ts" 就是在说仓库里有这个文件，
 * 拼错了、删了、改名了，都该红。
 */
function extractPaths(md: string): string[] {
  const out: string[] = [];
  // 允许 / （相对路径）和 . （扩展名/裸文件名），首字符必须是字母或下划线。
  for (const m of md.matchAll(/`([A-Za-z_][A-Za-z0-9_./-]*\.[a-z]{1,4})`/g)) {
    const p = m[1]!;
    if (p.startsWith('http')) continue;
    // 常见命令/工具名带参数的不算
    if (/^(npm|npx|node|tsx|git|sudo|curl|cd|ls|cp|mv|echo|cat|grep|sqlite3|systemctl)\b/.test(p)) continue;
    // 域名形状的不算（docs/skills.md 里有 ipquality.example / api.github.com 之类）
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(p) && !p.includes('/')) continue;
    // 代码调用形状的不算
    if (/[()]/.test(p)) continue;
    out.push(p);
  }
  return [...new Set(out)];
}

/**
 * 一个引用算不算存在。
 *
 * 带 `/` 的相对路径直接按仓库根解析（这些文档都在根或 docs/ 下，
 * README/CONTRIBUTING 在根，docs/*.md 引用 `src/x/y.ts` 也按根算）。
 * 裸文件名（表格里的 `humanizer.ts`）在几个常见目录里任一命中即算。
 */
function referenceExists(ref: string): boolean {
  if (ref.includes('/')) return existsSync(ref);
  const name = ref;
  return existsSync(`src/${name}`)
    || existsSync(`docs/${name}`)
    || existsSync(`prompts/task/${name}`)
    || existsSync(`prompts/system/${name}`)
    || existsSync(`prompts/identity/${name}`)
    || existsSync(`prompts/safety/${name}`)
    || existsSync(`prompts/contract/${name}`)
    || existsSync(`prompts/style/${name}`)
    || existsSync(`skills/${name}`)
    || existsSync(`packages/nyatdb/${name}`)
    || existsSync(`tests/unit/${name}`)
    || existsSync(`data/${name}`)
    || existsSync(`scripts/${name}`);
}

describe('文档引用的路径都存在', () => {
  for (const doc of DOCS) {
    it(`${doc} 引用的每个路径都在仓库里`, () => {
      const md = readFileSync(doc, 'utf8');
      const paths = extractPaths(md);
      // 阈值 1：这条测试管的是"引用的都要在"，不是"每篇都要引用够 N 个"。
      // 1 = 至少解析到一个，证明正则没坏（正则坏了就永远绿，那比红更糟）。
      expect(paths.length, `${doc} 一个路径引用都没解析到——正则该修了`).toBeGreaterThan(0);
      const missing = paths.filter((p) => !referenceExists(p));
      expect(missing, `${doc} 引用了不存在的路径`).toEqual([]);
    });
  }
});
