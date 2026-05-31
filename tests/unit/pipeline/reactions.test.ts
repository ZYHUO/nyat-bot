import { describe, it, expect } from 'vitest';
import { chooseReaction } from '../../../src/pipeline/reactions.js';

describe('chooseReaction', () => {
  it('funny text → 😁 / 🤣', () => {
    for (const s of ['哈哈哈笑死', 'lol hhhh', '2333 绝了']) {
      expect(['😁', '🤣']).toContain(chooseReaction(s));
    }
  });
  it('cute text → 🥰 / ❤ / 😍', () => {
    expect(['🥰', '❤', '😍']).toContain(chooseReaction('你好可爱呀'));
    expect(['🥰', '❤', '😍']).toContain(chooseReaction('抱抱~ 喜欢你'));
  });
  it('cool text → 🔥 / 💯 / 👏', () => {
    expect(['🔥', '💯', '👏']).toContain(chooseReaction('太强了 yyds'));
    expect(['🔥', '💯', '👏']).toContain(chooseReaction('牛逼 tql'));
  });
  it('plain / empty text → null (not reaction-worthy)', () => {
    expect(chooseReaction('今天天气不错')).toBeNull();
    expect(chooseReaction('几点了')).toBeNull();
    expect(chooseReaction('')).toBeNull();
  });
});
