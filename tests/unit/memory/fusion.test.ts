import { describe, it, expect } from 'vitest';
import { rrfFuse, RRF_K } from '../../../src/memory/fusion.js';

type Doc = { id: string; from?: string };
const d = (id: string, from?: string): Doc => ({ id, from });
const key = (x: Doc) => x.id;
const ids = (r: Doc[]) => r.map((x) => x.id);

describe('RRF 融合', () => {
  it('两路都命中的排在只有一路命中的前面', () => {
    const vector = [d('a'), d('b'), d('c')];
    const lexical = [d('c'), d('x'), d('y')];
    // c 在两路都出现(名次 3 和 1),a 只在向量路第 1
    // c: 1/63 + 1/61 = 0.0323 ; a: 1/61 = 0.0164
    expect(ids(rrfFuse([vector, lexical], key))[0]).toBe('c');
  });

  it('同一路内名次越靠前得分越高', () => {
    expect(ids(rrfFuse([[d('a'), d('b'), d('c')]], key))).toEqual(['a', 'b', 'c']);
  });

  it('单路输入等价于原样返回', () => {
    const only = [d('a'), d('b')];
    expect(ids(rrfFuse([only], key))).toEqual(['a', 'b']);
  });

  it('尊重 limit', () => {
    expect(rrfFuse([[d('a'), d('b'), d('c'), d('d')]], key, { limit: 2 })).toHaveLength(2);
  });

  it('空输入返回空', () => {
    expect(rrfFuse([], key)).toEqual([]);
    expect(rrfFuse([[], []], key)).toEqual([]);
  });

  it('一路为空时退化成另一路', () => {
    expect(ids(rrfFuse([[d('a'), d('b')], []], key))).toEqual(['a', 'b']);
    expect(ids(rrfFuse([[], [d('a'), d('b')]], key))).toEqual(['a', 'b']);
  });

  // 同一路内的重复如果各自计分,重复项会被变相加权 —— 那是 bug,不是特性。
  it('同一路内重复的 key 只按最靠前的名次计一次分', () => {
    const withDup = [d('a'), d('a'), d('a'), d('b')];
    expect(ids(rrfFuse([withDup], key))).toEqual(['a', 'b']);
  });

  it('保留第一次见到的那个对象 —— 信息更全的路应排在前面传入', () => {
    const vector = [d('c', 'vector')];   // 带 score/payload
    const lexical = [d('c', 'lexical')]; // 只有 id
    expect(rrfFuse([vector, lexical], key)[0]?.from).toBe('vector');
  });

  it('k 越大,头部名次之间的差距越平', () => {
    const lists = [[d('a'), d('b')]];
    const gapSmallK = (1 / (1 + 1)) - (1 / (1 + 2));
    const gapBigK = (1 / (1000 + 1)) - (1 / (1000 + 2));
    expect(gapBigK).toBeLessThan(gapSmallK);
    // 排序本身不受 k 影响
    expect(ids(rrfFuse(lists, key, { k: 1 }))).toEqual(ids(rrfFuse(lists, key, { k: 1000 })));
  });

  it('默认 k 是 60(RRF 原论文取值)', () => {
    expect(RRF_K).toBe(60);
  });

  // 这是混合检索存在的意义:向量路完全没召回到的东西,词法路能捞上来。
  it('词法路独有的命中不会被向量路挤掉', () => {
    const vector = [d('v1'), d('v2'), d('v3')];
    const lexical = [d('黑话专名'), d('v1')];
    const fused = ids(rrfFuse([vector, lexical], key, { limit: 3 }));
    expect(fused).toContain('黑话专名');
  });
});
