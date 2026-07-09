import { describe, it, expect } from 'vitest';
import { detectEmergentTics } from '../../../src/learners/tic-detector.js';

const OPTS = { minMessages: 4, minFraction: 0.35 };

describe('detectEmergentTics (口头禅自动检测)', () => {
  it('抓句首复读:「我勒个X」', () => {
    const texts = [
      '我勒个锄大地停不下来喵',
      '我勒个出片还是快喵',
      '我勒个狠活炒面看着香',
      '我勒个这贴纸比我还会装',
      '今天天气不错',
      '在吗',
    ];
    const hits = detectEmergentTics(texts, OPTS);
    const heads = hits.filter((h) => h.pos === 'head').map((h) => h.phrase);
    expect(heads.some((p) => p.includes('我勒个'))).toBe(true);
  });

  it('抓句尾复读:「…是吧」', () => {
    const texts = [
      '全自动晦气机是吧',
      '越南盲盒是吧',
      '判定大师是吧',
      '复读上瘾是吧',
      '换个话题',
    ];
    const hits = detectEmergentTics(texts, OPTS);
    expect(hits.some((h) => h.pos === 'tail' && h.phrase.includes('是吧'))).toBe(true);
  });

  it('去重:保留更具体的更长短语', () => {
    const texts = Array(6).fill('我勒个宝这也太强了');
    const hits = detectEmergentTics(texts, OPTS);
    const heads = hits.filter((h) => h.pos === 'head');
    // 不应同时保留「我勒」「我勒个」「我勒个宝」多条互相包含的
    expect(heads.length).toBe(1);
    expect([...heads[0]!.phrase].length).toBeGreaterThanOrEqual(3);
  });

  it('低于阈值不误报', () => {
    const texts = [
      '我勒个这个好玩',   // 只 2 条含「我勒个」,不足 minMessages=4
      '我勒个那个也行',
      '今天吃什么',
      '在吗',
      '好的',
      '晚安',
    ];
    const hits = detectEmergentTics(texts, OPTS);
    expect(hits.some((h) => h.phrase.includes('我勒个'))).toBe(false);
  });

  it('句尾纯「喵」不当口头禅(由 thinMeow 另管)', () => {
    const texts = ['好的喵', '知道了喵', '在的喵', '来啦喵', '收到喵'];
    const hits = detectEmergentTics(texts, OPTS);
    // 归一剥掉喵后,句尾候选是「好的/知道了/…」各不相同,不该冒出「喵」这条
    expect(hits.some((h) => /^喵+$/.test(h.phrase))).toBe(false);
  });

  it('空输入安全', () => {
    expect(detectEmergentTics([], OPTS)).toEqual([]);
  });
});
