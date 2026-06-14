import { describe, it, expect } from 'vitest';
import { minePairs, parseExtraction } from '../../../src/learners/bot-command-learner.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

const BOT_UID = 9999;
function msg(o: Partial<FormattedMessage>): FormattedMessage {
  return {
    role: 'user', uid: 1, username: 'u', fullName: 'U', timestamp: 1000,
    messageId: 1, textContent: '', isForwarded: false, ...o,
  } as FormattedMessage;
}

describe('minePairs', () => {
  it('命令 → 紧随的 bot 回应配对;output_type=text', () => {
    const msgs = [
      msg({ messageId: 10, uid: 1, textContent: '/geo 8.8.8.8', timestamp: 100 }),
      msg({ messageId: 11, uid: 5, username: 'uzumaru_geoip_bot', isBot: true, textContent: 'IP: 8.8.8.8 ASN Google', timestamp: 105 }),
    ];
    const { pairs, safeMaxMid } = minePairs(msgs, BOT_UID, 0);
    expect(pairs.length).toBe(1);
    expect(pairs[0]).toMatchObject({ bot: 'uzumaru_geoip_bot', command: '/geo', args: '8.8.8.8', outputType: 'text' });
    expect(safeMaxMid).toBe(10); // 配上对即结清,水位推进到命令 mid
  });

  it('回执只有 callback 按钮、无正文 → output_type=callback', () => {
    const msgs = [
      msg({ messageId: 20, uid: 1, textContent: '/q', timestamp: 100 }),
      msg({ messageId: 21, uid: 5, username: 'b', isBot: true, textContent: '', timestamp: 102,
        inlineKeyboard: [{ text: '查看结果', callbackData: 'x' }] }),
    ];
    expect(minePairs(msgs, BOT_UID, 0).pairs[0]!.outputType).toBe('callback');
  });

  it('watermark 之前的命令不再计数', () => {
    const msgs = [
      msg({ messageId: 30, uid: 1, textContent: '/geo a', timestamp: 100 }),
      msg({ messageId: 31, uid: 5, username: 'b', isBot: true, textContent: 'ok', timestamp: 101 }),
    ];
    expect(minePairs(msgs, BOT_UID, 30).pairs.length).toBe(0); // mid 30 <= wm
  });

  it('窗口边缘(命令在末尾、回应未到)→ 不配对且不推进水位(review #8)', () => {
    // 命令是最后一条,后面没有消息 → 窗口未结清
    const msgs = [
      msg({ messageId: 99, uid: 2, textContent: '闲聊', timestamp: 90 }),
      msg({ messageId: 100, uid: 1, textContent: '/geo 9.9.9.9', timestamp: 100 }),
    ];
    const { pairs, safeMaxMid } = minePairs(msgs, BOT_UID, 0);
    expect(pairs.length).toBe(0);
    expect(safeMaxMid).toBe(0); // 未结清,水位不推进 → 下个 tick 回应到了能重挖
  });

  it('通用命令(/start)不学,但已结清则推进水位(review #10)', () => {
    const msgs = [
      msg({ messageId: 60, uid: 1, textContent: '/start', timestamp: 100 }),
      msg({ messageId: 61, uid: 9, username: 'welcome_bot', isBot: true, textContent: '欢迎新人', timestamp: 101 }),
      ...Array.from({ length: 6 }, (_, k) => msg({ messageId: 70 + k, uid: 2, textContent: 'x', timestamp: 110 + k })),
    ];
    const { pairs, safeMaxMid } = minePairs(msgs, BOT_UID, 0);
    expect(pairs.find((p) => p.command === '/start')).toBeUndefined(); // 不学 /start
    expect(safeMaxMid).toBeGreaterThanOrEqual(60); // 已结清,水位推进
  });

  it('回应明确 reply 了别的消息 → 不误配', () => {
    const msgs = [
      msg({ messageId: 80, uid: 1, textContent: '/geo a', timestamp: 100 }),
      msg({ messageId: 81, uid: 5, username: 'b', isBot: true, textContent: '回别人的', timestamp: 101,
        replyTo: { messageId: 79, uid: 3, fullName: 'X', textSnippet: 'other' } }),
      ...Array.from({ length: 6 }, (_, k) => msg({ messageId: 90 + k, uid: 2, textContent: 'x', timestamp: 110 + k })),
    ];
    expect(minePairs(msgs, BOT_UID, 0).pairs.length).toBe(0);
  });

  it('@指向时只配对该 bot;bot 触发标 triggerByBot', () => {
    const msgs = [
      msg({ messageId: 40, uid: BOT_UID, username: 'hunhebi_bot', isBot: true, textContent: '/geo@uzumaru_geoip_bot 1.1.1.1', timestamp: 100 }),
      msg({ messageId: 41, uid: 7, username: 'other_bot', isBot: true, textContent: 'noise', timestamp: 101 }),
      msg({ messageId: 42, uid: 5, username: 'uzumaru_geoip_bot', isBot: true, textContent: 'IP: 1.1.1.1', timestamp: 102 }),
    ];
    const { pairs } = minePairs(msgs, BOT_UID, 0);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.bot).toBe('uzumaru_geoip_bot');
    expect(pairs[0]!.triggerByBot).toBe(true);
  });

  it('命令后窗口内无 bot 回应 → 不配对', () => {
    const msgs = [
      msg({ messageId: 50, uid: 1, textContent: '/geo x', timestamp: 100 }),
      msg({ messageId: 51, uid: 2, textContent: '随便聊', timestamp: 101 }),
    ];
    expect(minePairs(msgs, BOT_UID, 0).pairs.length).toBe(0);
  });
});

describe('parseExtraction', () => {
  it('解析 JSON 数组,过滤缺字段项', () => {
    const raw = '前言\n[{"bot":"b","command":"/geo","output_type":"text"},{"command":"/x"},{"bot":"c","command":"/y"}]\n尾';
    const r = parseExtraction(raw);
    expect(r.length).toBe(2);
    expect(r[0]!.bot).toBe('b');
  });
  it('无 JSON → 空数组', () => {
    expect(parseExtraction('没有数组')).toEqual([]);
  });
});
