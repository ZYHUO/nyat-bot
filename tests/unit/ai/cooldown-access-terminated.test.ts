import { describe, expect, it } from 'vitest';

/**
 * round 71：`access_terminated_error` 必须走长冷却。
 *
 * Round 70 实测：dshkimi 的 403 从纯并发限流变成了
 * `access_terminated_error`——消息体里 `concurrent request limit` 还在，
 * 所以现在分级还认得出来。
 *
 * 但那是幸运：如果有一天只剥出 type、文案换掉，
 * round 182 的分级就会把它当成普通 RPM 限流\uff08短冷却\uff09——
 * 而并发限流要的是"等在飞请求跑完"，不是等墙上时钟。
 *
 * 这里钢住两件事：新 type 命中长冷却分支；
 * 而没有 type 的普通限流仍然走短的。
 */

import * as fs from 'node:fs';

const SRC = 'src/ai/fallback.ts';

describe('access_terminated_error 走长冷却', () => {
  const gradingBlock = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const i = code.findIndex((l) => l.includes('access_terminated_error'));
    expect(i, 'access_terminated_error 不在分级里').toBeGreaterThan(-1);
    return code.slice(Math.max(0, i - 3), i + 4).join('\n');
  };

  it('① 分级正则认得 access_terminated_error', () => {
    expect(gradingBlock()).toContain('access_terminated_error');
  });

  it('② 和并发限流在同一个分支里（同一个 setCooldown 调用）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const i = code.findIndex((l) => l.includes('access_terminated_error'));
    const after = code.slice(i, i + 6).join('\n');
    expect(after).toContain('setCooldown(label.model, RATE_LIMIT_COOLDOWN_SEC)');
  });

  it('③ 普通限流仍走短冷却（没被这个改动带宽）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("incrCounter('llm_short_cooldown_total'");
    expect(s).toContain("else if (err instanceof AIError && err.code === 'AI_RATE_LIMIT')");
  });

  it('④ 注释写明 round 70 的实测依据（否则下一个人当多余的正则删掉）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 71:');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 400);
    expect(block).toContain('round 70');
    expect(block).toContain('dshkimi');
  });
});
