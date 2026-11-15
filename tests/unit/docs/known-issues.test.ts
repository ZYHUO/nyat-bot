import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * known-issues.md 里引用的路径/常量必须真实存在（round 110）。
 *
 * 这张表是"现在还没解决什么"的唯一入口。如果它指向的代码/命令是过期的，
 * 下一个人（或下一个 round）会照着错的方向查——那是这个会话付过最多学费
 * 的形状（doc 引用腐烂 round 37-39）。
 */
describe('known-issues 引用的东西都在', () => {
  const SRC = 'docs/known-issues.md';

  it('① 引用的源文件都在', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    for (const f of ['scripts/measure-voice.mts', 'scripts/measure-timing.mts']) {
      expect(fs.existsSync(f), f).toBe(true);
    }
    for (const f of ['src/ai/provider.ts', 'src/ai/fallback.ts', 'src/ai/smart-group.ts',
                     'src/tracking/outcome.ts', 'src/meta/heart-adapter.ts']) {
      expect(fs.existsSync(f), f).toBe(true);
    }
  });

  it('② 引用的 round 号对应的 commit message 存在（不是编的）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 至少这几轮的结论在 voice-tuning.md 里有记录
    const vt = fs.readFileSync('docs/voice-tuning.md', 'utf8');
    for (const marker of ['round 89', 'round 103', 'round 105']) {
      expect(s).toContain(marker);
      expect(vt.toLowerCase()).toContain(marker);
    }
  });

  it('③ 明确标了"我做过但无效的"（防下一个人重做）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('我做过但');
    expect(s).toContain('SMART_GROUP_AUTO_ASSIGN');
  });

  it('④ 明确标了第 3 档（需要人拍板的）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('第 3 档');
  });

  it('⑤ 量具的坑单独一节（我自己踩过的）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('量具的坑');
    expect(s).toContain('--since');
  });

  it('⑥ 被 README/Contents 引用（不然是一篇孤岛文档）', () => {
    const r = fs.readFileSync('README.md', 'utf8');
    expect(r).toContain('docs/known-issues.md');
  });
});
