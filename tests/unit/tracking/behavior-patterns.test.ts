import { describe, it, expect } from 'vitest';
import {
  NEGATIVE_PATTERNS,
  REPAIR_PATTERNS,
  POSITIVE_PATTERNS,
  countMatches,
} from '../../../src/tracking/behavior-patterns.js';

describe('behavior-patterns', () => {
  describe('countMatches', () => {
    it('counts each matching pattern once', () => {
      expect(countMatches('我没懂，而且你理解错了', NEGATIVE_PATTERNS)).toBeGreaterThanOrEqual(2);
    });

    it('returns 0 for empty text', () => {
      expect(countMatches('', NEGATIVE_PATTERNS)).toBe(0);
    });

    it('returns 0 when nothing matches', () => {
      expect(countMatches('今天天气不错我们去吃饭吧', REPAIR_PATTERNS)).toBe(0);
    });

    it('counts a single match', () => {
      expect(countMatches('啊这也太离谱了', NEGATIVE_PATTERNS)).toBe(1);
    });

    it('is case-insensitive for latin substrings', () => {
      expect(countMatches('OK', ['ok'])).toBe(1);
    });
  });

  describe('NEGATIVE_PATTERNS', () => {
    it('matches representative negative reactions', () => {
      const samples = [
        '没懂你在说什么',
        '不对吧',
        '你理解错了',
        '完全看不懂',
        '听不懂你说啥',
        '你说错了',
        '真无语',
        '太离谱了',
      ];
      for (const s of samples) {
        expect(countMatches(s, NEGATIVE_PATTERNS), s).toBeGreaterThan(0);
      }
    });
  });

  describe('REPAIR_PATTERNS', () => {
    it('matches representative repair/restatement messages', () => {
      const samples = [
        '我是说那个东西',
        '我说的是另一件事',
        '你搞错了，不是这个',
        '不是这个意思',
        '我意思是想问明天',
      ];
      for (const s of samples) {
        expect(countMatches(s, REPAIR_PATTERNS), s).toBeGreaterThan(0);
      }
    });
  });

  describe('POSITIVE_PATTERNS', () => {
    it('matches representative positive reactions', () => {
      const samples = [
        '谢谢你',
        '懂了懂了',
        '可以的',
        '这个有用',
        '不错哦',
        '明白了',
        '你说得对的',
      ];
      for (const s of samples) {
        expect(countMatches(s, POSITIVE_PATTERNS), s).toBeGreaterThan(0);
      }
    });
  });

  describe('no false positives on neutral text', () => {
    const neutral = [
      '今天我们一起去公园玩好吗',
      '这部电影的剧情挺有意思的',
      '帮我查一下明天的天气',
      '晚上想吃火锅还是烧烤',
      '我刚买了一本新书',
    ];

    it('neutral chat does not trigger negative patterns', () => {
      for (const s of neutral) {
        expect(countMatches(s, NEGATIVE_PATTERNS), s).toBe(0);
      }
    });

    it('neutral chat does not trigger repair patterns', () => {
      for (const s of neutral) {
        expect(countMatches(s, REPAIR_PATTERNS), s).toBe(0);
      }
    });

    it('neutral chat does not trigger positive patterns', () => {
      for (const s of neutral) {
        expect(countMatches(s, POSITIVE_PATTERNS), s).toBe(0);
      }
    });
  });
});
