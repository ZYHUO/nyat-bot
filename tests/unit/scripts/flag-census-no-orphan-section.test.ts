import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * flag-census 不能再漏段（round 192）。
 *
 * `src/env-sections/ai.ts`（8 个 JEV_* 旗标）加进来之后，census 的
 * `SECTION_ORDER` 是**手写的 12 段**，没把 `ai` 加进去——于是它报
 * `total_keys: 488`，而实际 schema 是 496，`docs/flag-census.md`
 * 也跟着停在 488。
 *
 * 这是 round 21 那个「flag-census 从 round 21 起就没更新过」的同型复发：
 * 清单靠人记得补。修法是把段列表改成 glob，加测试钉住"目录里的每一段
 * 都要被统计到"。
 */
// execSync 跑全仓 grep，24s 量级 —— describe 级放开。
// 脚本扫全仓 ~25s。跑一次给本文件所有测试共用——每个 it 各跑一次会让整个
// 文件超过 60s（这个会话第 N 次被自己的测试超时咬到）。
let censusOut = '';
beforeAll(() => { censusOut = execSync('python3 scripts/flag-census.py', { encoding: 'utf8' }); }, 120_000);

describe('flag-census 不漏段', { timeout: 60000 }, () => {
  const SRC = 'scripts/flag-census.py';

  it('① 段列表用 glob，不靠手写', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("glob.glob('src/env-sections/*.ts')");
    // 循环体不能再去遍历那个手写数组
    const loopBlock = s.slice(
      s.indexOf('flags: list[dict] = []'),
      s.indexOf('flags.extend(parse_section(SRC'),
    );
    expect(loopBlock).not.toContain('for sec in SECTION_ORDER');
  });

  it('② 目录里的每个段文件都在 SECTION_ORDER 里（不然输出顺序不稳定）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const dir = fs.readdirSync('src/env-sections').filter((f) => f.endsWith('.ts') && !f.startsWith('_'));
    const listed = s.slice(s.indexOf('SECTION_ORDER = ['), s.indexOf(']', s.indexOf('SECTION_ORDER = [')));
    for (const f of dir) {
      const sec = f.replace('.ts', '');
      expect(listed, `段 ${sec} 不在 SECTION_ORDER 里`).toContain(`'${sec}'`);
    }
  });

  it('③ 跑出来的 total_keys 与 schema-sections 测试钉的键数一致', () => {
    const m = censusOut.match(/"total_keys":\s*(\d+)/);
    expect(m).not.toBeNull();
    const census = Number(m![1]);
    // 测试文件里写的期望键数（形如 496 = 488 + 8）
    const test = fs.readFileSync('tests/unit/env/schema-sections.test.ts', 'utf8');
    const t = test.match(/EXPECTED_KEY_COUNT\s*=\s*(\d+)/) ?? test.match(/toBe\((\d+)/);
    expect(t, 'schema-sections 测试里没找到期望键数').not.toBeNull();
    const pinned = Number(t![1]);
    expect(census, `census 报 ${census} 而测试钉 ${pinned}`).toBe(pinned);
  });

  it('④ 段索引表也覆盖每一段（round 192 漏掉的另一半）', () => {
    // round 192 只钉了 total_keys——那部分确实修好了。但脚本里有**两份**
    // SECTION_ORDER，round 192 改的是顶部那份，输出构造区那份不含 'ai' 把它盖住，
    // 于是键数对了（497）而段索引仍停在 12 段/488。这个坑留了 6 轮。
    const doc = fs.readFileSync('docs/flag-census.md', 'utf8');
    const idxStart = doc.indexOf('## 段索引');
    const idxEnd = doc.indexOf('## 总量');
    expect(idxStart).toBeGreaterThan(-1);
    expect(idxEnd).toBeGreaterThan(idxStart);
    const listed = [...doc.slice(idxStart, idxEnd).matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
    const dir = fs.readdirSync('src/env-sections')
      .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
      .map((f) => f.replace('.ts', ''));
    for (const sec of dir) {
      expect(listed, `段索引里没有 ${sec}（键数可能对但索引漏段）`).toContain(sec);
    }
    expect(listed.length).toBe(dir.length);
    // 段表键数合计 == total_keys（round 196 抓过的那种内部不一致）
    const keySums = [...doc.slice(idxStart, idxEnd).matchAll(/\| (\d+) \| \d+ \| \d+ \|/g)]
      .map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
    const total = Number(censusOut.match(/"total_keys":\s*(\d+)/)![1]);
    expect(keySums, `段表合计 ${keySums} != total_keys ${total}`).toBe(total);
    
  });

  it('⑤ 没有死键开着（dead_and_on 必须 0）', () => {
    const m = censusOut.match(/"dead_and_on":\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0);
  });
});
