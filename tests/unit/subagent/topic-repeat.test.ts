import { describe, expect, it } from 'vitest';
import { cjkBigrams, findTopicRepeat } from '../../../src/subagent/topic-repeat.js';

/**
 * 话题词复用闸（round 162）—— 用户 2026-09-23 21:51 现场报的 bug。
 *
 * 现场是 30 秒 7 个气泡，"固定资产"出现 3 次，读起来就是重复回复。
 * 仓里已有的去重全是整句相同那一族（isEchoOf / 4 字前缀 / 语义相似度），
 * 抓不到"同一个词换着句子说"。
 */
describe('话题词复用闸', () => {
  it('① 复现现场：6 条历史里"固定资产"3 次 → 拦', () => {
    const history = [
      '算固定资产改良',
      '记你名下按月扣折旧',
      '下次戴手套，省得增加审计工作量喵',
      '行',
      '窗台固定资产台账更新，下次审计重点查窗台磨损喵',
    ];
    const hit = findTopicRepeat(history, '窗台也要入固定资产台账，明年折旧记得摊到你头上喵');
    expect(hit).toBeDefined();
    expect(hit!.hits).toBe(3);
    expect(['固定', '定资', '资产']).toContain(hit!.bigram);
  });

  it('② 同一个词只出现 2 次不拦（阈值是 3，不是 2）', () => {
    const history = ['窗台固定资产台账更新，下次审计重点查窗台磨损喵'];
    const hit = findTopicRepeat(history, '窗台也要入固定资产台账，明年折旧记得摊到你头上喵');
    expect(hit).toBeUndefined();
  });

  it('③ 停用词密集也不拦（口癖/功能词任何对话都有）', () => {
    const history = [
      '这个真的可以',
      '就是一个说法',
      '这个我知道',
      '可以的话就行',
      '这个那个的',
    ];
    // 满篇"这个/可以/就是"，一个都不该拦
    expect(findTopicRepeat(history, '这个真的可以吗')).toBeUndefined();
  });

  it('④ 正常聊一个话题（同一个词不到 3 次）不拦', () => {
    const history = [
      '今天天气不错啊',
      '晚上吃什么',
      '刚下班累死了',
      '周末去哪玩',
      '这只猫好胖',
    ];
    // "猫"是一字组，不出现在 bigram 里；"好胖"只在 1 条历史里 → 不拦
    expect(findTopicRepeat(history, '猫确实胖')).toBeUndefined();
  });

  it('⑤ 标点不参与组词（中文逗号两侧不拼成词）', () => {
    const g = cjkBigrams('你好，世界');
    expect(g.has('好世')).toBe(false);
    expect(g.has('你好')).toBe(true);
    expect(g.has('世界')).toBe(true);
  });

  it('⑥ 英文/数字被剔掉，不会和汉字拼出伪词', () => {
    const g = cjkBigrams('deepseekv4 真厉害');
    expect(g.has('p真')).toBe(false);
    expect(g.has('真厉')).toBe(true);
  });

  it('⑦ window 参数生效（只数最近 N 条）', () => {
    // 6 条：前两条带资产，后四条不带。slice(-6) 全覆盖 → 2 次历史 + 候选 = 3。
    const history = ['固定资产A', '固定资产B', '别的', '别的', '别的', '别的'];
    // window=2 只看最后两条（都没有"资产"）+ 候选 = 1 次 → 不拦
    expect(findTopicRepeat(history, '固定资产C', { window: 2 })).toBeUndefined();
    // window=6 覆盖前两条 + 候选 = 3 次 → 拦
    const hit = findTopicRepeat(history, '固定资产C', { window: 6 });
    expect(hit?.hits).toBe(3);
    expect(hit?.window).toBe(6);
  });

  it('⑧ minHits 可调，收紧到 2 就能拦现场', () => {
    const history = ['窗台固定资产台账更新', '窗台也要入固定资产台账'];
    expect(findTopicRepeat(history, '固定资产又来了', { minHits: 2 })?.hits).toBeGreaterThanOrEqual(2);
  });

  it('⑨ 历史为空/候选无汉字 → 不拦（fail-open）', () => {
    expect(findTopicRepeat([], '固定资产')).toBeUndefined();
    expect(findTopicRepeat(['固定资产', '固定资产', '固定资产'], 'ok fine')).toBeUndefined();
  });

  it('⑩ 纯函数无状态：同样输入永远同样输出', () => {
    const h = ['固定资产A', '固定资产B', '固定资产C'];
    const a = findTopicRepeat(h, '固定资产D');
    const b = findTopicRepeat(h, '固定资产D');
    expect(a).toEqual(b);
  });
});
