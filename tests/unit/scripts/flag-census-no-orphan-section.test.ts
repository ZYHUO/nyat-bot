import { describe, expect, it } from 'vitest';
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
    const out = execSync('python3 scripts/flag-census.py', { encoding: 'utf8' });
    const m = out.match(/"total_keys":\s*(\d+)/);
    expect(m).not.toBeNull();
    const census = Number(m![1]);
    // 测试文件里写的期望键数（形如 496 = 488 + 8）
    const test = fs.readFileSync('tests/unit/env/schema-sections.test.ts', 'utf8');
    const t = test.match(/EXPECTED_KEY_COUNT\s*=\s*(\d+)/) ?? test.match(/toBe\((\d+)/);
    expect(t, 'schema-sections 测试里没找到期望键数').not.toBeNull();
    const pinned = Number(t![1]);
    expect(census, `census 报 ${census} 而测试钉 ${pinned}`).toBe(pinned);
  });

  it('④ 没有死键开着（dead_and_on 必须 0）', () => {
    const out = execSync('python3 scripts/flag-census.py', { encoding: 'utf8' });
    const m = out.match(/"dead_and_on":\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0);
  });
});
