import { describe, expect, it } from 'vitest';

/**
 * round 71：`access_terminated_error` \u5fc5\u987b\u8d70\u957f\u51b7\u5374\u3002
 *
 * Round 70 \u5b9e\u6d4b\uff1adshkimi \u7684 403 \u4ece\u7eaf\u5e76\u53d1\u9650\u6d41\u53d8\u6210\u4e86
 * `access_terminated_error`\u2014\u2014\u6d88\u606f\u4f53\u91cc `concurrent request limit` \u8fd8\u5728\uff0c
 * \u6240\u4ee5\u73b0\u5728\u5206\u7ea7\u8fd8\u8ba4\u5f97\u51fa\u6765\u3002
 *
 * \u4f46\u90a3\u662f\u5e78\u8fd0\uff1a\u5982\u679c\u6709\u4e00\u5929\u53ea\u5265\u51fa type\u3001\u6587\u6848\u6362\u6389\uff0c
 * round 182 \u7684\u5206\u7ea7\u5c31\u4f1a\u628a\u5b83\u5f53\u6210\u666e\u901a RPM \u9650\u6d41\uff08\u77ed\u51b7\u5374\uff09\u2014\u2014
 * \u800c\u5e76\u53d1\u9650\u6d41\u8981\u7684\u662f"\u7b49\u5728\u98de\u8bf7\u6c42\u8dd1\u5b8c"\uff0c\u4e0d\u662f\u7b49\u5899\u4e0a\u65f6\u949f\u3002
 *
 * \u8fd9\u91cc\u94a2\u4f4f\u4e24\u4ef6\u4e8b\uff1a\u65b0 type \u547d\u4e2d\u957f\u51b7\u5374\u5206\u652f\uff1b
 * \u800c\u6ca1\u6709 type \u7684\u666e\u901a\u9650\u6d41\u4ecd\u7136\u8d70\u77ed\u7684\u3002
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
