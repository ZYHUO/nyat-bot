import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * ASI rubric 的 maxTokens 必须够 reasoning 模型用（round 69）。
 *
 * 2026-09-23。`asi-scoring.ts:306` 显式传 `maxTokens: ASI_RUBRIC_MAX_TOKENS`，
 * 而显式参数压过 usage 级配置。ASI 链现在指向 step-3.7-flash——
 * reasoning 模型，`reasoning_content` 计入 completion。
 *
 * 09-23 实测 285 次空正文，全部来自 stepfun 三个标签 × maxTokens=1200。
 *
 * 而源码里那行注释（"给小了只会拿到空 content"）在 round 26 就写对了，
 * 值一直没改——**代码知道病因而配了错的值**，这是最隐蔽的一类。
 */
describe('ASI rubric maxTokens', () => {
  it('① 默认值 >= 8000（reasoning 模型的思维链要占掉一大截）', () => {
    const src = fs.readFileSync('src/env-sections/social.ts', 'utf8');
    const m = src.match(/ASI_RUBRIC_MAX_TOKENS[\s\S]{0,400}?\.default\((\d+)\)/);
    expect(m, '找不到 ASI_RUBRIC_MAX_TOKENS 的 default').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(8000);
  });

  it('② 与 vision 的量级可比（都是推理模型，别只给一家喂饱）', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const vision = Number(env.match(/^AI_USAGE_VISION_MAX_TOKENS=(\d+)$/m)?.[1] ?? 0);
    const rubric = Number(env.match(/^ASI_RUBRIC_MAX_TOKENS=(\d+)$/m)?.[1] ?? 0);
    expect(vision).toBeGreaterThan(0);
    // rubric 该在 vision 的同一量级（vision 32000）
    expect(rubric).toBeGreaterThanOrEqual(8000);
    expect(rubric).toBeLessThanOrEqual(vision * 2);
  });

  it('③ .env.example 里有这一项（.env gitignored，示例要能复现）', () => {
    const ex = fs.readFileSync('.env.example', 'utf8');
    expect(ex).toMatch(/^ASI_RUBRIC_MAX_TOKENS=\d+$/m);
  });

  it('④ 调用点仍是显式参数——round 26 同族，改值不改形状', () => {
    // 这一条锁住"别以为删掉显式参数就好"：usage 级配置没有等价键，
    // 删了会落到 provider 默认（可能更小）。改值是正确解。
    const src = fs.readFileSync('src/tracking/asi-scoring.ts', 'utf8');
    expect(src).toContain('maxTokens: env().ASI_RUBRIC_MAX_TOKENS');
  });
});
