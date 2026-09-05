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
    // cursor review #6 + review-workflow P1 误报回归集
    '说起来这个挺好玩的',
    '说实话我有点惊讶',
    '说得对',
    '发现一个宝藏频道',
    '发烧了好难受',
    '发展得还不错',
    '发自内心地喜欢',
    '停车场没位置了',
    '讲道理这不怪我',
    '讲真的我服了',
    '给我看看你的猫',
    '写得不错',
    '画风好怪',
    '继续加油',
    '别走啊',
    '念念不忘',
    '读读看呗这本书',
  ])('ignores chatter/questions: %s', (text) => {
    expect(detectInstruction(msg(text), addressed)).toBeNull();
  });

  it.each([
    '说一下你的看法',
    '停止刷屏',
    '发个贴纸',
    '给我翻译翻译',
  ])('still detects after the tightening: %s', (text) => {
    expect(detectInstruction(msg(text), addressed)).toEqual({ strength: 'normal' });
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

  it('hint mentions execution-over-persona; master variant keeps veto but not kneeling', () => {
    expect(buildInstructionHint({ strength: 'normal' })).toContain('执行优先于人设');
    const masterHint = buildInstructionHint({ strength: 'master' });
    expect(masterHint).toContain('优先级最高');
    expect(masterHint).toContain('主人≠主子');
    expect(masterHint).not.toContain('必须服从');
  });
});
