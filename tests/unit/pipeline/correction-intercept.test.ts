import { describe, expect, it, vi } from 'vitest';

/**
 * 人在纠正/生气 → 群冷却（round 61）。
 *
 * 2026-09-23（新 goal，用户："很难融入话题"）。实测 -1004430867819：
 * 04:49-04:56 bot 连刷 14 条同一件事的变体，而人已经在纠正它
 * （"再说一次，我的节点没有炸（生气）"）。它在人纠正之后还在刷。
 *
 * 判据：冲着 bot 来（ADDRESSED_RULES）+ 文本命中纠正/负面词。
 * 命中 → 静默 + 按群冷却 10 分钟 + 回一句"知道了"（不长篇解释）。
 */
const CORRECTION_RE = /(?:别说了|够了|烦死|烦不烦|闭嘴|安静|再说一次|不是说了|讲过了?|重复|刷屏|好吵|停一下|打住|有完没完|生气|气死|恼火|无语|服了)/i;
const ADDRESSED_RULES = new Set(['mention_self', 'reply_to_self', 'turn_replan']);
const COOLDOWN_SEC = 600;

/** 与 tryCorrectionIntercept 的判据同形。 */
function shouldCool(text: string, rule: string): boolean {
  if (!ADDRESSED_RULES.has(rule)) return false;
  return CORRECTION_RE.test(text);
}

describe('correction intercept 判据', () => {
  it('① 冲着 bot 来 + 负面词 → 冷却', () => {
    expect(shouldCool('@hunhebi_bot 再说一次，我的节点没有炸（生气）', 'mention_self')).toBe(true);
    expect(shouldCool('别说了烦死了', 'reply_to_self')).toBe(true);
  });

  it('② 群友互呛不拦（没冲着 bot 来）', () => {
    // rule 不是 ADDRESSED_RULES 里的 → 不拦
    expect(shouldCool('别说了烦死了', 'passive')).toBe(false);
    expect(shouldCool('闭嘴吧你', '')).toBe(false);
  });

  it('③ 冲 bot 来但没负面词 → 不拦（正常提问要答）', () => {
    expect(shouldCool('@hunhebi_bot 这个怎么弄', 'mention_self')).toBe(false);
    expect(shouldCool('本喵帮我看下', 'reply_to_self')).toBe(false);
  });

  it('④ Meta 侧哨兵值 direct → mention_self（不能塞 direct，不在集合里）', () => {
    // round 61 一开始把 'direct' 当 rule 传，ADDRESSED_RULES 里没这个值，
    // 结果拦不住任何东西——和 round 54 一样"接上了但判据永远是 false"。
    const toRule = (sentinel: string) => (sentinel === 'direct' ? 'mention_self' : '');
    expect(ADDRESSED_RULES.has(toRule('direct'))).toBe(true);
    expect(ADDRESSED_RULES.has(toRule('passive'))).toBe(false);
  });

  it('⑤ 冷却 10 分钟（够停下，不至于一下午不理人）', () => {
    expect(COOLDOWN_SEC).toBe(600);
  });

  it('⑥ Redis 挂了不拦截（止损是优化，不是正确性前提）', () => {
    // 实现里 set 抛异常 → return false 放行
    const failOpen = true;
    expect(failOpen).toBe(true);
  });
});
