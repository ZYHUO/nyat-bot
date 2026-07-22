import { describe, expect, it } from 'vitest';
import { looksLikeDiaryRequest } from '../../../src/meta/session.js';

describe('looksLikeDiaryRequest', () => {
  it('matches common user asks', () => {
    expect(looksLikeDiaryRequest('猫猫再写个日记看看')).toBe(true);
    expect(looksLikeDiaryRequest('写日记')).toBe(true);
    expect(looksLikeDiaryRequest('写个日记呗')).toBe(true);
    expect(looksLikeDiaryRequest('看看日记')).toBe(true);
    expect(looksLikeDiaryRequest('日记呢')).toBe(true);
    expect(looksLikeDiaryRequest('笨猫你今天日记写了吗')).toBe(true);
  });

  it('ignores unrelated chat and CodeAct skip summaries', () => {
    expect(looksLikeDiaryRequest('今天吃什么')).toBe(false);
    expect(looksLikeDiaryRequest('记一下明天开会')).toBe(false);
    expect(looksLikeDiaryRequest('')).toBe(false);
    // Regression: callback summaries used to re-trigger diary intercept → double reply
    expect(looksLikeDiaryRequest('老实解释今天发呆没写日记')).toBe(false);
    expect(looksLikeDiaryRequest('老实承认今天没素材写日记')).toBe(false);
    expect(looksLikeDiaryRequest('日记未写：skipped_or_empty')).toBe(false);
  });
});
