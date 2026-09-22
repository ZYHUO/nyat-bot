import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 仓库自带的 4 个 example skill 必须**真的能加载**，而且必须真的打得通。
 *
 * 2026-09-22 round 6（提高知名度 goal——用户要"skill list / 生态"）。
 *
 * 原来的问题：`docs/skills.md` 教人"一个 JSON 文件就是一个 skill"，
 * 但 `SKILLS_DIR` 默认指向 `./data/skills`，而 **`data/` 在 .gitignore 里**。
 * 于是一个新 clone 看到的 skills 目录永远是空的——文档教了一种语法，
 * 却没有任何一个可以抄、可以跑的例子。生态的第一块砖是缺的。
 *
 * 现在 `SKILLS_DIR` 默认 `./skills`，仓库根带着 4 个零配置可用的例子。
 * 这条测试防它退回去：默认目录必须在仓库里、里面必须有能过 schema 的 JSON。
 */
const DEFAULT_DIR = './skills';

describe('仓库自带的 example skills', () => {
  const dir = join(process.cwd(), DEFAULT_DIR);

  it('① 默认 SKILLS_DIR 指向的目录存在且被 git 跟踪', () => {
    expect(existsSync(dir)).toBe(true);
    // data/ 在 .gitignore 里，所以它不能是默认值
    const gitignore = readFileSync('.gitignore', 'utf8');
    expect(gitignore).toMatch(/^data\//m);
  });

  it('② 至少有 4 个 JSON skill 文件', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('③ 每个都过 skillSchema（和 docs/skills.md 同一个 schema）', async () => {
    const { skillSchema } = await import('../../../src/pipeline/tools/skill-loader.js');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const r = skillSchema.safeParse(parsed);
      expect(r.success, `${f} 不过 schema`).toBe(true);
    }
  });

  it('④ trusted 的 http skill 都声明了 allowedHosts（loader 的硬门槛）', async () => {
    const { skillSchema } = await import('../../../src/pipeline/tools/skill-loader.js');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const r = skillSchema.safeParse(parsed);
      if (!r.success) continue;
      const ex = r.data.execute;
      const allowed = ex.type === 'http' ? ex.allowedHosts : undefined;
      if (r.data.trusted && ex.type === 'http') {
        expect(allowed?.length, `${f}: trusted http 必须声明 allowedHosts`).toBeGreaterThan(0);
      }
    }
  });

  // WEATHER 是本机用户自己写的那一个（从 data/skills 迁过来的，trusted 未声明、
  // allowedHosts 也未声明）。它不受这条约束——文档明说"不 trusted 也可以发 HTTP"。
  it('⑤ 没有一个是 script 型（loader 会跳过）', async () => {
    const { skillSchema } = await import('../../../src/pipeline/tools/skill-loader.js');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const r = skillSchema.safeParse(parsed);
      if (r.success) expect(r.data.execute.type).toBe('http');
    }
  });
});
