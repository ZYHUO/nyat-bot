import { describe, it, expect } from 'vitest';
import { thinMeowTic, segmentReply } from '../../../src/pipeline/reply/segmenter.js';

describe('thinMeowTic (喵口癖抑制)', () => {
  it('短促句一律去喵', () => {
    expect(thinMeowTic(['对对对喵'])).toEqual(['对对对']);
    expect(thinMeowTic(['确实喵'])).toEqual(['确实']);
    expect(thinMeowTic(['好的喵~'])).toEqual(['好的~']);
  });

  it('保留核心话与波浪号/表情,只摘喵本体', () => {
    expect(thinMeowTic(['知道啦喵😼'])).toEqual(['知道啦😼']);
  });

  it('纯「喵」/「喵~」是完整发言,不动', () => {
    expect(thinMeowTic(['喵'])).toEqual(['喵']);
    expect(thinMeowTic(['喵~'])).toEqual(['喵~']);
    expect(thinMeowTic(['喵呜'])).toEqual(['喵呜']);
  });

  it('多条长句:隔一个去一个,整体压到约一半', () => {
    const segs = [
      '这个节点延迟有点高不太行喵',   // 长句#1 → 保留(奇数)
      '你要不要换一个香港的试试喵',   // 长句#2 → 去(偶数)
      '反正我这边看着是通的喵',       // 长句#3 → 保留
      '不行再找我喵',                 // 长句#4 → 去
    ];
    const out = thinMeowTic(segs);
    const meowCount = out.filter((s) => /喵/.test(s)).length;
    expect(meowCount).toBe(2); // 4 → 2
    expect(out[0]).toContain('喵');
    expect(out[1]).not.toContain('喵');
  });

  it('没有句尾喵的句子原样返回', () => {
    expect(thinMeowTic(['草 这也行', '确实离谱'])).toEqual(['草 这也行', '确实离谱']);
  });

  it('长中文不会静默变成默认嗯，且每段受长度上限约束', () => {
    const text = '这是一个很长的中文回复，'.repeat(80);
    const { segments } = segmentReply(text, { maxLength: 120, maxSentenceNum: 3, periodDropRate: 0 });
    expect(segments.join('')).toContain('这是一个很长的中文回复');
    expect(segments).not.toEqual(['嗯']);
    expect(segments.every((s) => s.length <= 120)).toBe(true);
  });

  it('超过最大自然段数时保留内容而不是返回整段原文或嗯', () => {
    const text = ['第一段内容。', '第二段内容。', '第三段内容。', '第四段内容。', '第五段内容。'].join('');
    const { segments } = segmentReply(text, { maxLength: 20, maxSentenceNum: 3, periodDropRate: 0 });
    expect(segments).not.toEqual(['嗯']);
    expect(segments.join('')).toContain('第五段内容');
    expect(segments.every((s) => s.length <= 20)).toBe(true);
  });
});
