import { describe, expect, it } from 'vitest';
import { chatStylePromptLine, type ChatStyle } from '../../../src/tracking/chat-style.js';

describe('chatStylePromptLine（群风格 prompt 提示）', () => {
  it('短打群：叫 bot 也短打', () => {
    const s: ChatStyle = { medianChars: 8, emojiDensity: 0.2, quoteRatio: 0.05, punctEndRate: 0.2, microStyle: true, sampleSize: 30 };
    const line = chatStylePromptLine(s);
    expect(line).toContain('短打群');
    expect(line).toContain('别条条顶引用');
    expect(line).toContain('别句句句号收尾');
  });

  it('长聊群：别句句压短', () => {
    const s: ChatStyle = { medianChars: 45, emojiDensity: 0.1, quoteRatio: 0.1, punctEndRate: 0.5, microStyle: false, sampleSize: 40 };
    expect(chatStylePromptLine(s)).toContain('别句句压成十几个字');
  });

  it('高引用率群：有指向就带上', () => {
    const s: ChatStyle = { medianChars: 20, emojiDensity: 0.1, quoteRatio: 0.5, punctEndRate: 0.5, microStyle: false, sampleSize: 30 };
    expect(chatStylePromptLine(s)).toContain('有明确指向就带上');
  });

  it('null 样本 → 空串', () => {
    expect(chatStylePromptLine(null)).toBe('');
  });
});
