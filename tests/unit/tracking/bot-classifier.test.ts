import { describe, it, expect } from 'vitest';
import { classifyBotMessage, suggestedBotAction } from '../../../src/tracking/bot-classifier.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

function bm(o: Partial<FormattedMessage>): FormattedMessage {
  return {
    role: 'user', uid: 5, username: 'b', fullName: 'B', timestamp: 1, messageId: 1,
    textContent: '', isForwarded: false, isBot: true, ...o,
  } as FormattedMessage;
}

describe('classifyBotMessage(基于真实群样本)', () => {
  it('入群验证 / 封禁 → verify', () => {
    for (const t of [
      '入群验证 欢迎加入群组！请完成入群验证。请在 2 分钟内完成验证以免被永久封禁。',
      'z***i 由于验证已过期，未能完成入群验证，已被永久封禁。',
      'Ai 已通过入群验证。',
    ]) expect(classifyBotMessage(bm({ username: 'nmBot', textContent: t })), t).toBe('verify');
  });

  it('机场广告(促销+价格同时命中)→ ad', () => {
    expect(classifyBotMessage(bm({ username: 'nmBot', textContent: 'Another机场公益活动 🎁 Another公益优惠卡 Another free 💎Another机场最低3元每月' }))).toBe('ad');
  });

  it('群里正常聊机场/VPS(无促销报价)→ 不误判成 ad', () => {
    // 这类是人/会话,但即便是 bot 转述,缺价格信号也不该 ad
    expect(classifyBotMessage(bm({ username: 'somebot', textContent: '这个机场节点延迟有点高,丢包也多' }))).not.toBe('ad');
  });

  it('复读三连 → echo', () => {
    expect(classifyBotMessage(bm({ username: '妙妙小工具Beta', textContent: '黑幕！黑幕！黑幕！' }))).toBe('echo');
    expect(classifyBotMessage(bm({ username: 'x', textContent: '咕咕嘎嘎！咕咕嘎嘎！咕咕嘎嘎！' }))).toBe('echo');
  });

  it('下载/解析类 bot 或有命令档案 → cmd_result', () => {
    expect(classifyBotMessage(bm({ username: '聚合解析姬', textContent: '▎解 析 中...' }))).toBe('cmd_result');
    expect(classifyBotMessage(bm({ username: 'randombot', textContent: 'IP: 1.1.1.1 ASN' }), { hasCommandProfile: true })).toBe('cmd_result');
  });

  it('会话型同类 bot(千雪)→ chat(互动候选)', () => {
    expect(classifyBotMessage(bm({ username: 'qianxue_bot', fullName: '千雪', textContent: '数学鬼才是吧' }))).toBe('chat');
  });

  it('自己 → self', () => {
    expect(classifyBotMessage(bm({ role: 'assistant', username: '' }), { isSelf: true })).toBe('self');
    expect(classifyBotMessage(bm({ role: 'assistant' }))).toBe('self');
  });

  it('普通 bot 短消息 → unknown', () => {
    expect(classifyBotMessage(bm({ username: 'somebot', textContent: '已购用户已增加10天' }))).toBe('unknown');
  });
});

describe('suggestedBotAction(动作映射)', () => {
  it('降噪类 → suppress / ignore;互动 → interact;学习 → learn', () => {
    expect(suggestedBotAction('ad')).toBe('suppress');
    expect(suggestedBotAction('echo')).toBe('suppress');
    expect(suggestedBotAction('verify')).toBe('ignore');
    expect(suggestedBotAction('chat')).toBe('interact');
    expect(suggestedBotAction('cmd_result')).toBe('learn');
    expect(suggestedBotAction('unknown')).toBe('learn');
    expect(suggestedBotAction('self')).toBe('ignore');
  });
});
