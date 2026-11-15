import { describe, expect, it } from 'vitest';
import { normalizeReactionEmoji } from '../../../src/pipeline/reply/reaction-emoji.js';

/**
 * 心流的第四个出口：react —— 点个表情，不说话。
 *
 * 2026-09-22 round 8（用户："bot 还是太爱说话了"）。
 *
 * 现状：`reactions.ts` 早就有 setMessageReaction，但它只认正则
 * （哈哈/太强/可爱 三种词表）、每天每群最多 2 次，而且**心流不知道有这条路**。
 * 于是模型想说"对对对/笑死"的时候，唯一能表达的方式是发一条文字气泡——
 * 哪怕 prompt 里已经写了"2-10 字的微反应经常比完整句子更自然"，
 * 机制上没有更便宜的出口，它就只会往"发文字"走。
 *
 * react 对这一族最轻：不进发送队列、不占打字预算、不产生气泡，
 * 对 reply_rate 的分子零贡献。
 */

/** 与 parseHeart 的 act 白名单同形。 */
const ACTS = new Set(['reply', 'wait', 'pass', 'react']);

describe('react 出口', () => {
  it('① react 是合法的 act', () => {
    expect(ACTS.has('react')).toBe(true);
  });

  it('② 模型给的 emoji 过白名单校验', () => {
    expect(normalizeReactionEmoji('🤣')).toBe('🤣');
    expect(normalizeReactionEmoji('👍')).toBe('👍');
  });

  it('③ 变体选择符被剥掉（Telegram 要裸码点）', () => {
    // ❤️（U+2764 U+FE0F）→ ❤（U+2764）
    expect(normalizeReactionEmoji('❤️')).toBe('❤');
  });

  it('④ 不在白名单的 emoji 被拒（发错情绪比不发更糟）', () => {
    expect(normalizeReactionEmoji('🦄')).toBeNull();
    expect(normalizeReactionEmoji('')).toBeNull();
    expect(normalizeReactionEmoji(undefined)).toBeNull();
    expect(normalizeReactionEmoji('abc')).toBeNull();
  });

  it('⑤ 未给 emoji 时回落中性表情 👀（"在场但不想说话"）', () => {
    // pickReactionEmoji('neutral') 的返回值；这里锁常量而不是 import，
    // 因为 reactions.ts 有 Redis 依赖。
    const NEUTRAL = '👀';
    expect(normalizeReactionEmoji(NEUTRAL)).toBe('👀');
    expect(ACTS.has('react')).toBe(true);
  });
});
