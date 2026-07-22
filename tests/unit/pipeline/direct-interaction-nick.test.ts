import { describe, expect, it } from 'vitest';
import { detectDirectInteraction } from '../../../src/pipeline/timing/direct-interaction.js';

const base = {
  botUid: 1,
  botUsername: 'hunhebi_bot',
  botNicknames: ['啾咪囝', '啾咪', 'xxb'],
};

function msg(text: string) {
  return {
    message: {
      text,
      chat: { type: 'supergroup' },
    },
  };
}

describe('detectDirectInteraction nicknames', () => {
  it('matches 啾咪 with adjacent CJK as nickname kind', () => {
    expect(detectDirectInteraction(msg('叫啾咪干嘛'), base)).toBe('nickname');
    expect(detectDirectInteraction(msg('啾咪'), base)).toBe('nickname');
    expect(detectDirectInteraction(msg('啾咪囝在吗'), base)).toBe('nickname');
  });

  it('matches ASCII nick with word boundary only', () => {
    expect(detectDirectInteraction(msg('xxb 在吗'), base)).toBe('nickname');
    expect(detectDirectInteraction(msg('axxb'), base)).toBeNull();
  });

  it('@username stays mention', () => {
    expect(detectDirectInteraction(msg('hey @hunhebi_bot'), base)).toBe('mention');
  });

  it('ignores unrelated chatter', () => {
    expect(detectDirectInteraction(msg('今天好热'), base)).toBeNull();
  });
});
