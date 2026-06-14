import { describe, it, expect } from 'vitest';
import { needsLookup } from '../../../src/pipeline/heart/path-heuristic.js';

describe('path heuristic (replaces L0 microJudge backfill)', () => {
  it.each([
    '帮我查一下比特币价格',
    '现在汇率多少',
    '明天天气怎么样',
    '搜一下这个错误怎么解决',
    '最新的新闻有什么',
    'https://github.com/foo/bar 这个项目咋样',
    '查下这个ip的归属地',
    '现在几点了',
    '帮我点首晴天',
    '点歌 水手',
    '来一首周杰伦的歌',
  ])('lookup → planned: %s', (t) => expect(needsLookup(t)).toBe(true));

  it.each([
    '你吃早饭没',
    '哈哈哈笑死',
    '对对对',
    '你觉得这个方案靠谱吗',
    '给我讲个笑话',
    '帮我把这段翻译成英文',
    '今天好累啊',
  ])('chat → direct: %s', (t) => expect(needsLookup(t)).toBe(false));
});
