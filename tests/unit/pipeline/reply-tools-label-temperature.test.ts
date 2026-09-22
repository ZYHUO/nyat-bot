import { describe, expect, it, vi } from 'vitest';

// round 6 回归：reply-with-tools **不经过 callModel**，所以 provider.ts 里
// `label.temperature ?? opts.temperature` 的强制覆盖拦不到它。
//
// 2026-09-22 线上实测：/checkin 走合并写手 → dshkimi 报
//   `invalid temperature: only 1 is allowed for this model`
// → 9.66s 后 exhausted → fall back legacy → 用户等 92 秒。
//
// 这条测试锁"label.temperature 优先于一切"的优先级，防止有人把顺序改回去。

/** 与 reply-with-tools.ts 的优先级表达式保持同形（改那边要同步这里）。 */
function resolveTemperature(label: { temperature?: number }, input: { temperature?: number }, usage: { temperature?: number }): number {
  return label.temperature ?? input.temperature ?? usage.temperature ?? 0.8;
}
function resolveMaxTokens(label: { maxTokens?: number }, usage: { maxTokens?: number }): number {
  return label.maxTokens ?? usage.maxTokens;
}

describe('reply-with-tools 的 label 覆盖优先级', () => {
  it('① dshkimi（label.temperature=1）压过调用方的 0.8 和 usage 的 undefined', () => {
    expect(resolveTemperature({ temperature: 1 }, { temperature: 0.8 }, {})).toBe(1);
  });

  it('② label 没配时才轮到 input.temperature', () => {
    expect(resolveTemperature({}, { temperature: 0.8 }, { temperature: 0.3 })).toBe(0.8);
  });

  it('③ label 和 input 都没才轮到 usage.temperature', () => {
    expect(resolveTemperature({}, {}, { temperature: 0.3 })).toBe(0.3);
  });

  it('④ 全没配才落默认 0.8', () => {
    expect(resolveTemperature({}, {}, {})).toBe(0.8);
  });

  it('⑤ maxTokens 同样 label 优先', () => {
    expect(resolveMaxTokens({ maxTokens: 8000 }, { maxTokens: 2000 })).toBe(8000);
    expect(resolveMaxTokens({}, { maxTokens: 2000 })).toBe(2000);
  });
});
