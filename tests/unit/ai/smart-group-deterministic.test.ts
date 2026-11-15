import { describe, expect, it, vi } from 'vitest';

// round 9 回归：确定性 usage（judge/summarize/reflection）必须排除
// temperature 被锁死的 label。
//
// 实测 `smartGroupAutoAssign('judge')` 曾返回 `dshkimi, stepfunvision,
// stepfunthink`。dshkimi（kimi-for-coding）只接受 temperature=1
// （打 0.7/0.8 直接 400 `invalid temperature`），于是：
//   · `callModel` 里 label.temperature ?? opts.temperature = 1 ?? 0 = 1
//   · judge 拿到随机性，"同一个输入给同一个答案"的语义落空
//   · env 里配的 `stepfun <- stepfunjudge` 被 auto-assign 整体旁路

/** 与 smart-group.ts 的过滤判据同形（改那边要同步这里）。 */
function excluded(profile: { requiresDeterministic?: boolean }, label: { temperature?: number }): boolean {
  return profile.requiresDeterministic === true && label.temperature !== undefined;
}

describe('smart group 的确定性过滤', () => {
  it('① judge 排除 temperature 锁死的 label（dshkimi temp=1）', () => {
    expect(excluded({ requiresDeterministic: true }, { temperature: 1 })).toBe(true);
  });

  it('② judge 不排除没配 temperature 的 label（stepfun/stepfunjudge）', () => {
    expect(excluded({ requiresDeterministic: true }, {})).toBe(false);
    expect(excluded({ requiresDeterministic: true }, { temperature: undefined })).toBe(false);
  });

  it('③ 非确定性 usage（reply）不排除 —— reply 要 temperature=1 的创造性', () => {
    expect(excluded({}, { temperature: 1 })).toBe(false);
  });

  it('④ artist 不参与（respectManualOrder 提前返回 []）——这条只锁语义，不锁路径', () => {
    // artist 的 profile 没有 requiresDeterministic，且 respectsManualOrder 会让
    // auto-assign 直接返回 []。这里确认 profile 层面不误伤。
    expect(excluded({ minTier: 'medium' }, { temperature: 0.7 })).toBe(false);
  });
});
