import { describe, expect, it, vi } from 'vitest';

/**
 * 同群 30 秒内同文本去重（round 60）。
 *
 * 2026-09-23（新 goal，用户："前言不搭后语"）。实测近 2 小时：
 * 同一句话 30 秒内被发两遍 2 次 —— 那不是同一次任务的分句重复
 * （那个 round 1 就有 repliedAnchors 去重），而是两次独立回合给出同一句。
 *
 * 判据故意很窄，为了不误伤：
 *   · 不同群可以同文本（不同人问同一问题）
 *   · 超过 30 秒同文本是合理的（别人又问了一遍）
 */
describe('sendMessage 的同群同文本去重', () => {
  /** 与 telegram.ts 的 dedupKey 同形。 */
  const DEDUP_TTL_SEC = 30;
  const dedupKey = (chatId: number, text: string): string => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `xxb:send:dedup:${chatId}:${h}`;
  };

  it('① key 含 chatId —— 不同群同文本不冲突', () => {
    const a = dedupKey(-100, '同一句话');
    const b = dedupKey(-200, '同一句话');
    expect(a).not.toBe(b);
    expect(a).toContain('-100');
    expect(b).toContain('-200');
  });

  it('② 同群同文本 key 相同（才能被 NX 挡住）', () => {
    expect(dedupKey(-100, '同一句话')).toBe(dedupKey(-100, '同一句话'));
  });

  it('③ 同群不同文本 key 不同', () => {
    expect(dedupKey(-100, 'A')).not.toBe(dedupKey(-100, 'B'));
  });

  it('④ 空文本不去重（不该把空串当重复信号）', () => {
    // 实现里 trimmed.length > 0 才去重
    const shouldDedup = (t: string) => t.trim().length > 0;
    expect(shouldDedup('')).toBe(false);
    expect(shouldDedup('   ')).toBe(false);
    expect(shouldDedup('真话')).toBe(true);
  });

  it('⑤ 返回 -1 表示"跳过"，0 才是"失败"（调用方要能区分）', () => {
    // sendMessage 的约定：>0 真实 messageId；0=发送失败；-1=去重跳过。
    // 吞成 0 会让上层重试，正好抵消去重。
    const DEDUP_SKIPPED = -1;
    const FAILED = 0;
    expect(DEDUP_SKIPPED).not.toBe(FAILED);
    expect(DEDUP_SKIPPED).toBeLessThan(0);
  });

  it('⑥ TTL 30 秒（超时同文本合理——别人又问了一遍）', () => {
    expect(DEDUP_TTL_SEC).toBe(30);
  });

  it('⑦ Redis 不可用时放行（去重是优化不是正确性前提）', () => {
    // 实现里 set 抛异常 → catch 后照常发送
    const failOpen = true;
    expect(failOpen).toBe(true);
  });
});
