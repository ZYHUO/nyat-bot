import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 62：**package.json 不许被"整份重写"削平**。
 *
 * Round 61 我为了加一个 npm script，用 python `json.dumps(重建的 dict)` 写回
 * package.json——把 25 个 dependencies、12 个 devDependencies、workspaces、
 * engines 全丢了，只剩 18 个 scripts。
 *
 * 归档的规矩是"改文件一律增量"，但规矩不执行自己。这个守卫执行它：
 * 把 package.json 的结构钉住，任何"读进来→改→整份写回"都会立刻红。
 *
 * 数字是 round 62 实测的基线；加依赖/脚本时这个测试会提醒你改它
 * ——那正是要人确认"我是有意的"的地方。
 */

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as Record<string, unknown>;

describe('package.json 结构完好', () => {
  it('① 顶层 key 一个不少（round 61 丢过 workspaces/engines）', () => {
    const expected = ['dependencies', 'description', 'devDependencies', 'engines',
      'main', 'name', 'private', 'scripts', 'type', 'version', 'workspaces'];
    expect(Object.keys(pkg).sort()).toEqual(expected);
  });

  it('② dependencies 25 个 / devDependencies 12 个（round 61 差点归零）', () => {
    expect(Object.keys(pkg['dependencies'] as object).length).toBe(25);
    expect(Object.keys(pkg['devDependencies'] as object).length).toBe(12);
  });

  it('③ workspaces 与 engines 还在', () => {
    expect(pkg['workspaces']).toBeDefined();
    expect(pkg['engines']).toBeDefined();
  });

  it('④ scripts 里有 round 60/61 新加的 tamper:audit', () => {
    const sc = pkg['scripts'] as Record<string, string>;
    expect(sc['tamper:audit']).toBe('tsx scripts/tamper-audit.mts --changed');
  });

  it('⑤ 每个 script 指向的文件真的存在（round 62 顺手加的）', () => {
    const sc = pkg['scripts'] as Record<string, string>;
    const missing: string[] = [];
    for (const [name, cmd] of Object.entries(sc)) {
      const m = cmd.match(/(?:tsx|node|bash)\s+(scripts\/[^\s]+)/);
      if (!m) continue;
      if (!fs.existsSync(m[1]!)) missing.push(`${name} -> ${m[1]}`);
    }
    expect(missing, 'script 指向的文件不见了：' + missing.join(', ')).toEqual([]);
  });
});
