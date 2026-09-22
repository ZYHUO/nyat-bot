import { describe, expect, it, vi } from 'vitest';

// round 10 回归：`AI_CONTENT_REJECTED` **不记熔断**。
//
// 2026-09-22 07:16 实测：stepfunvision 连续 5 次被 safety filter 拒
// （群里聊洗钱/广告内容）→ 3 次达 DEFAULT_FAILURE_THRESHOLD → 熔断 120s
// → 那 120s 内 **20 次 judge 调用全部 skipped**，用户看到"没回复"。
//
// 判据错位：safety filter 拒的是**这条内容**，不是 provider 的健康状态。
// 拿内容问题罚 provider = "这条消息有敏感词 ⇒ 这个模型坏了"。

/** 与 fallback.ts 的判据同形（改那边要同步这里）。 */
function shouldTripBreaker(err: { code?: string } | null, isContentRejected: boolean): boolean {
  return isContentRejected ? false : true;
}

describe('content rejected 不熔断', () => {
  it('① AI_CONTENT_REJECTED → 不记熔断', () => {
    const err = { code: 'AI_CONTENT_REJECTED' };
    const isContentRejected = err.code === 'AI_CONTENT_REJECTED';
    expect(shouldTripBreaker(err, isContentRejected)).toBe(false);
  });

  it('② AI_RATE_LIMIT → 仍然记（那是真的 provider 限流，与内容无关）', () => {
    const err = { code: 'AI_RATE_LIMIT' };
    const isContentRejected = err.code === 'AI_CONTENT_REJECTED';
    expect(shouldTripBreaker(err, isContentRejected)).toBe(true);
  });

  it('③ AI_TIMEOUT → 仍然记', () => {
    const err = { code: 'AI_TIMEOUT' };
    const isContentRejected = err.code === 'AI_CONTENT_REJECTED';
    expect(shouldTripBreaker(err, isContentRejected)).toBe(true);
  });

  it('④ 普通错误 → 仍然记', () => {
    const isContentRejected = false;
    expect(shouldTripBreaker(null, isContentRejected)).toBe(true);
  });
});
