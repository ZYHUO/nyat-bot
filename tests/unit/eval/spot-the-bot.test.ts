import { describe, it, expect } from 'vitest';

// H4 盲测 harness：框架断言（不烧真 LLM，不写穿 prompts）
// 验收标准来自 plan：50 bot + 50 真人混排，P(标为真人|bot) + P(标为bot|真人)
import {
  buildBlindSet,
  scoreBlindJudgments,
  BLIND_SET_SIZE,
  type BlindItem,
  type BlindJudgment,
} from '../../../src/eval/spot-the-bot.js';

const bot = (text: string): BlindItem => ({ source: 'bot', text });
const human = (text: string): BlindItem => ({ source: 'human', text });

describe('spot-the-bot harness (H4)', () => {
  it('buildBlindSet: 50/50 混排 + 洗牌后顺序不固定', () => {
    const bots = Array.from({ length: 50 }, (_, i) => `bot-${i}`);
    const humans = Array.from({ length: 50 }, (_, i) => `human-${i}`);
    const set = buildBlindSet(bots, humans);
    expect(set.length).toBe(BLIND_SET_SIZE);
    expect(set.filter((x) => x.source === 'bot').length).toBe(50);
    expect(set.filter((x) => x.source === 'human').length).toBe(50);
    // 洗牌：两次构建顺序大概率不同（100 项全同序概率可忽略）
    const set2 = buildBlindSet(bots, humans);
    const sameOrder = set.every((x, i) => x.text === set2[i]!.text);
    expect(sameOrder).toBe(false);
  });

  it('buildBlindSet: 数量不足抛错（防半吊子评测）', () => {
    expect(() => buildBlindSet(['a'], ['b'])).toThrow();
  });

  it('scoreBlindJudgments: 全标对 → P=0/0；全标反 → P=1/1', () => {
    const items = [bot('b1'), human('h1'), bot('b2'), human('h2')];
    const perfect: BlindJudgment[] = items.map((x) => ({ text: x.text, guessedHuman: x.source === 'human' }));
    const s = scoreBlindJudgments(items, perfect);
    expect(s.pHumanGivenBot).toBe(0); // bot 全被识破
    expect(s.pBotGivenHuman).toBe(0); // 真人全认对
    const flipped: BlindJudgment[] = items.map((x) => ({ text: x.text, guessedHuman: x.source === 'bot' }));
    const s2 = scoreBlindJudgments(items, flipped);
    expect(s2.pHumanGivenBot).toBe(1); // bot 全蒙混过关
    expect(s2.pBotGivenHuman).toBe(1); // 真人全被误杀
  });

  it('scoreBlindJudgments: 漏判按分母缩（不静默补 0）', () => {
    const items = [bot('b1'), human('h1')];
    const s = scoreBlindJudgments(items, [{ text: 'b1', guessedHuman: true }]);
    expect(s.judged).toBe(1);
    expect(s.pHumanGivenBot).toBe(1);
    expect(s.pBotGivenHuman).toBeNaN(); // 真人项无人判 → NaN 不硬填
  });
});
