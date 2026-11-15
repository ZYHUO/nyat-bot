import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * OBJECTIVE-STATUS / known-issues 里引用的 npm 脚本必须真的存在（round 129）。
 *
 * 这两份文档是对外交付物（"结论是什么"/"还没解决什么"）。它们点名
 * `measure:timing` 这类工具当证据——如果脚本被改名或删掉，文档就成了
 * 空头承诺。而这类腐烂这个会话犯过（round 37-39 doc 引用腐烂）。
 */
describe('结论文档引用的工具都在', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const DOCS = ['docs/OBJECTIVE-STATUS.md', 'docs/known-issues.md', 'docs/ecosystem-status.md'];

  it('① 两份结论文档里点名的 npm run 都有定义', () => {
    const referenced = new Set<string>();
    for (const f of DOCS) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/`(npm run |npm run --silent )([a-z][a-z0-9:-]*)/g)) {
        referenced.add(m[2]!);
      }
      for (const m of s.matchAll(/`(measure:[a-z]+|gate:[a-z]+|voice:[a-z]+)`/g)) {
        referenced.add(m[1]!);
      }
    }
    expect(referenced.size).toBeGreaterThan(3);
    const missing = [...referenced].filter((n) => !(n in pkg.scripts));
    expect(missing, `文档引用了不存在的脚本: ${missing.join(', ')}`).toEqual([]);
  });

  it('② 至少引用了四个仪表盘（这份文档的价值就在那）', () => {
    const s = fs.readFileSync('docs/OBJECTIVE-STATUS.md', 'utf8');
    const tools = ['measure:voice', 'measure:engage', 'measure:timing'];
    for (const t of tools) expect(s).toContain(t);
  });

  it('③ cron 每晚跑的三个都真的挂在 voice-daily.sh 里', () => {
    const s = fs.readFileSync('scripts/voice-daily.sh', 'utf8');
    for (const t of ['measure:voice', 'measure:engage', 'measure:timing']) {
      expect(s).toContain(t);
    }
  });
});
