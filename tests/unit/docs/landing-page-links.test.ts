import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 落地页里的**内部链接**必须真的解析得到文件。
 *
 * 2026-09-22 round 13。上一轮验外链时发现两个坑：
 *   1. `blob/main/docs/skills.md` —— 默认分支是 `nyatos`，`main` 落后 425 个 commit，
 *      这个链接在默认分支上 404
 *   2. `#install` —— README 的安装段真实标题是 `#### Manual install`，
 *      这个锚点不存在。而 GitHub 对坏锚点也返回 200，**curl 验不出来**，
 *      只有点过去才发现页面不跳
 *
 * 修法是全部改成相对路径（`../docs/skills.md`）——挂在 Pages、本地 file:// 打开、
 * 任何静态托管都对，且不受默认分支是哪条影响。
 *
 * 这条测试把"链了"和"到了"绑在一起。域名形外链（Star on GitHub）不查，
 * 它们必须保持绝对。
 */
const PAGE = 'website/index.html';
const BASE = dirname(PAGE);   // website/

function extractLinks(html: string): Array<{ href: string; ctx: string }> {
  const out: Array<{ href: string; ctx: string }> = [];
  for (const m of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    out.push({ href: m[1]!, ctx: m[2]!.replace(/<[^>]*>/g, '').trim().slice(0, 30) });
  }
  return out;
}

describe('落地页的内部链接', () => {
  const html = readFileSync(PAGE, 'utf8');
  const links = extractLinks(html);

  it('① 页面上有链接可查（否则这条测试是空的）', () => {
    expect(links.length).toBeGreaterThan(5);
  });

  it('② 没有写死 main 分支的 blob 链接（默认分支可能是别的）', () => {
    const badMain = links.filter((l) => l.href.includes('/blob/main/'));
    expect(badMain.map((l) => l.href)).toEqual([]);
  });

  it('③ README 的锚点是 README 里真有的（GitHub 对坏锚点也返 200，只能自己查）', () => {
    const readme = readFileSync('README.md', 'utf8');
    const anchors = new Set<string>();
    for (const m of readme.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      // GitHub 的锚点算法：小写、空格转 -、去掉标点
      anchors.add(m[1]!.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'));
    }
    for (const l of links) {
      const a = l.href.match(/#([\w-]+)$/);
      if (!a) continue;
      // 裸 #xxx 是页内锚点，跳过（#try / #extend 是真有的，下面 ⑤ 单独验）
      if (l.href.startsWith('#')) continue;
      expect(anchors.has(a[1]!), `锚点 #${a[1]} 不在 README 里（链接 "${l.ctx}"）`).toBe(true);
    }
  });

  it('④ 所有相对链接都解析到真实文件', () => {
    for (const l of links) {
      const href = l.href;
      if (href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:')) continue;
      const target = resolve(BASE, href.split('#')[0]!);
      expect(existsSync(target), `相对链接 "${href}"（${l.ctx}）解析不到文件`).toBe(true);
    }
  });

  it('⑤ 页内锚点 #try / #extend 在页面里有对应 id', () => {
    for (const id of ['try', 'extend']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('⑥ Star / GitHub 两个 CTA 保持绝对链接（它们必须跳出去）', () => {
    const outbound = links.filter((l) => l.href.startsWith('https://github.com/'));
    expect(outbound.length).toBeGreaterThanOrEqual(2);
  });
});
