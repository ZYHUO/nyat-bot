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
    // 2026-06-29 拓宽:知识/解释/对比类直问也走 planned(agentic 专家)
    '这是啥意思',
    '为什么天是蓝的',
    'python循环怎么写',
    'A和B对比一下哪个好',
    '这两个有什么区别',
    '介绍一下这个梗',
    '求推荐个降噪耳机',
  ])('lookup → planned: %s', (t) => expect(needsLookup(t)).toBe(true));

  it.each([
    '你吃早饭没',
    '哈哈哈笑死',
    '对对对',
    '你觉得这个方案靠谱吗',
    '给我讲个笑话',
    '帮我把这段翻译成英文',
    '今天好累啊',
    // M5:收敛后,闲聊式附和/裸词提及不再误进 planned
    '我还是觉得好',
    '那还是算了',
    '你这方法不行啊',
    '没步骤啊',
    '你怎么看',
  ])('chat → direct: %s', (t) => expect(needsLookup(t)).toBe(false));
});
