import { describe, it, expect } from 'vitest';
import { detectInstruction, buildInstructionHint } from '../../../src/pipeline/reply/instruction.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

function msg(text: string, over: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 1001,
    messageId: 1,
    fullName: 'Alice',
    username: 'alice',
    textContent: text,
    timestamp: 0,
    isBot: false,
    isForwarded: false,
    ...over,
  } as FormattedMessage;
}

const addressed = { addressed: true, isMasterUser: false };

describe('instruction detection', () => {
  it.each([
    '帮我把刚才那段翻译成英文',
    '再说一遍',
    '发两条消息,一条给我一条给他',
    '把你刚才说的重复一遍',
    '用英语回答',
    '别再发贴纸了',
    '闭嘴',
    '总结一下群里在聊什么',
    '@xxb_bot 列出你会的功能',
    '告诉张三明天开会',
    'please translate this to English',
    'repeat what you just said',
  ])('detects: %s', (text) => {
    expect(detectInstruction(msg(text), addressed)).toEqual({ strength: 'normal' });
  });

  it.each([
    '今天天气真好',
    '哈哈哈笑死',
    '为什么会这样?',
    '是什么意思',
    '你觉得这个怎么样',
    '我刚才发现一个好东西',
  ])('ignores chatter/questions: %s', (text) => {
    expect(detectInstruction(msg(text), addressed)).toBeNull();
  });

  it('requires the bot to be addressed', () => {
    expect(detectInstruction(msg('再说一遍'), { addressed: false, isMasterUser: false })).toBeNull();
  });

  it('master gets master strength', () => {
    const r = detectInstruction(msg('把这段翻译一下'), { addressed: true, isMasterUser: true });
    expect(r).toEqual({ strength: 'master' });
  });

  it('bots and anonymous admins cannot instruct', () => {
    expect(detectInstruction(msg('再说一遍', { isBot: true }), addressed)).toBeNull();
    expect(detectInstruction(msg('再说一遍', { isAnonymous: true }), addressed)).toBeNull();
  });

  it('hint mentions execution-over-persona; master variant mentions 主人', () => {
    expect(buildInstructionHint({ strength: 'normal' })).toContain('执行优先于人设');
    expect(buildInstructionHint({ strength: 'master' })).toContain('主人的指令必须服从');
  });
});
