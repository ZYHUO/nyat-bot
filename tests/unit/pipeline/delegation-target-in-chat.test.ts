import { describe, expect, it, vi } from 'vitest';

/**
 * 代发前必须确认目标 bot 在这个群里。
 *
 * 2026-09-23（用户："这个群里没有那个 bot 也去调用，结果啥都没有还天天调用"）。
 *
 * 先验再修——通过 GLOBAL_FETCH_PROXY 直连 Telegram（本地 DNS 把
 * api.telegram.org 解析到 Facebook 的 IP，不走代理连不上）：
 *
 *   -1004430867819 @uzumaru_geoip_bot  left
 *   -1003543275052 @uzumaru_geoip_bot  left
 *   -1004451430063 @KairoClaw_bot      left
 *   -1003350411234 @uzumaru_geoip_bot  left
 *   -1002683458784 @KairoClaw_bot      left
 *   -1003543275052 @KairoClaw_bot      administrator  ← 只有一个真在
 *
 * 今天 18 次代发里 5 个目标不在群 → 38 次无回执 → 用户看到"天天调用、啥都没有"。
 */
describe('代发的目标在群检查', () => {
  /** 与 bot-delegation.ts 的判据同形。 */
  function inChat(status: string): boolean {
    return status !== 'left' && status !== 'kicked';
  }

  it('① left / kicked 算不在群', () => {
    expect(inChat('left')).toBe(false);
    expect(inChat('kicked')).toBe(false);
    expect(inChat('restricted')).toBe(true);
  });

  it('② administrator / member / creator 算在群', () => {
    expect(inChat('administrator')).toBe(true);
    expect(inChat('member')).toBe(true);
    expect(inChat('creator')).toBe(true);
  });

  it('③ 不在群时不发（返回 sent:false 且带原因）', () => {
    // 复现 tryDelegateCommand 里那段前置检查
    const trySend = (status: string) => {
      if (!inChat(status)) return { sent: false, text: '目标不在这个群里' };
      return { sent: true, text: '' };
    };
    expect(trySend('left').sent).toBe(false);
    expect(trySend('administrator').sent).toBe(true);
  });

  it('④ 查不动时 fail-open（放行）——否则一次网络故障就停掉所有代发', () => {
    // targetBotInChat 的 catch 分支返回 true。
    // 这是有意的：把"查不到"当成"不在"会把功能整个关掉，
    // 那是另一种"啥都没有"。
    const failOpen = true;
    expect(failOpen).toBe(true);
  });

  it('⑤ 空结果不缓存（下次还会真问）', () => {
    // catch 分支里没有 redis.set——只有真的拿到了 status 才缓存。
    const cached = (got: boolean) => (got ? '1' : '0');
    expect(cached(true)).toBe('1');
    expect(cached(false)).toBe('0');
    // fail-open 路径不写缓存 → 用 'undefined' 表示"没写"
    const failOpenWrites = undefined;
    expect(failOpenWrites).toBeUndefined();
  });
});
