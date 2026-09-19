import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// semantic-dup 依赖 env()（flag+阈值+端点）和全局 fetch（TypeSafe System One）。
// env 是静态 import，直接 mock 模块即可。
const envMock = {
  SEMANTIC_DUP_ENABLED: true,
  SEMANTIC_DUP_THRESHOLD: 0.7,
  TYPESAFE_ENDPOINT: 'https://api.typesafe.ai/v1/systemone',
  TYPESAFE_MODEL: 'jev-latest',
  TYPESAFE_API_KEY: 'test-key',
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const { checkSemanticRepeat, semanticRepeatError, MIN_CANDIDATE_CHARS } = await import(
  '../../../src/subagent/semantic-dup.js'
);

function mockJev(probability: number | null) {
  return vi.fn(async (_url: unknown, _init: unknown) => {
    if (probability === null) throw new Error('network down');
    return {
      ok: true,
      json: async () => ({ answers: { same: { noul: probability } } }),
    } as unknown as Response;
  });
}

beforeEach(() => {
  envMock.TYPESAFE_API_KEY = 'test-key';
  envMock.SEMANTIC_DUP_THRESHOLD = 0.7;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 校准基线（36 对人工标注的真实生产配对，2026-09-19）：
//   REPEAT p: min .11  mean .84  max .97   ← 同义改写落在字面守卫盲区
//   DIFF   p: min .07  mean .27  max .72
// 注意下面这两对**字面**相似度都只有 0.11~0.12 —— 旧的 bigram 守卫必然漏掉，
// 这正是语义守卫存在的理由。
const PARAPHRASE_PAIR = [
  '20块能买到这么嫩的排骨，血赚啊喵',
  '20块这品质血赚啊，怎么做的喵',
];
const DISTINCT_PAIR = ['走，贴创可贴去喵', '急什么，创可贴又不会跑喵'];

describe('checkSemanticRepeat', () => {
  it('flags a paraphrase flood pair as a repeat', async () => {
    vi.stubGlobal('fetch', mockJev(0.68));
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false); // 0.68 < 0.7 threshold — near miss must not block
    expect(r.probability).toBe(0.68);
  });

  it('flags the sleepy-greeting variants (the production incident)', async () => {
    vi.stubGlobal('fetch', mockJev(0.81));
    const r = await checkSemanticRepeat(
      ['嗯…主人还没睡呀？蹭蹭，困到连爪子都抬不起来了喵'],
      '嗯…主人也还没睡呀？本喵困到要流口水了喵',
    );
    expect(r.isRepeat).toBe(true);
    expect(r.collidedWith).toContain('困到连爪子都抬不起来');
  });

  it('lets a genuinely different follow-up through', async () => {
    vi.stubGlobal('fetch', mockJev(0.21));
    const r = await checkSemanticRepeat([DISTINCT_PAIR[0]], DISTINCT_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(r.probability).toBe(0.21);
  });

  it('does not judge very short candidates (口癖/纠正补发天然相似)', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ answers: { same: { noul: 0.99 } } }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkSemanticRepeat(['本喵不干喵'], '嗯');
    expect(r.isRepeat).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(MIN_CANDIDATE_CHARS).toBe(8);
  });

  it('does not judge when nothing was sent before in this task', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ answers: { same: { noul: 0.99 } } }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkSemanticRepeat([], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only compares against the last 3 priors (token budget)', async () => {
    const fetchSpy = mockJev(0.9);
    vi.stubGlobal('fetch', fetchSpy);
    const priors = [
      '第一条历史消息内容足够长',
      '第二条历史消息内容足够长',
      '第三条历史消息内容足够长',
      '第四条历史消息内容足够长',
      '第五条历史消息内容足够长',
      '第六条历史消息内容足够长',
      '第七条历史消息内容足够长',
    ];
    await checkSemanticRepeat(priors, '候选消息内容在这里也足够长');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.state).toContain('第七条历史消息内容足够长');
    expect(body.state).not.toContain('第一条历史消息内容足够长');
    expect(body.state.match(/bot 已发送#\d/g)).toEqual(['bot 已发送#1', 'bot 已发送#2', 'bot 已发送#3']);
    expect(body.state).toContain('候选消息内容在这里也足够长');
  });

  it('fails open when JeV is unreachable (never swallow a message on infra failure)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(r.probability).toBeNull();
    // one retry, then give up
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails open when the API returns non-2xx', async () => {
    vi.stubGlobal('fetch', mockJev(null));
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(r.probability).toBeNull();
  });

  it('fails open when no API key is configured', async () => {
    envMock.TYPESAFE_API_KEY = '';
    const fetchSpy = mockJev(0.95);
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('respects a custom threshold', async () => {
    envMock.SEMANTIC_DUP_THRESHOLD = 0.6;
    vi.stubGlobal('fetch', mockJev(0.68));
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(true);
  });
});

describe('semanticRepeatError', () => {
  it('reads as a felt, actionable fact — not a system error code', () => {
    const msg = semanticRepeatError({ isRepeat: true, probability: 0.68, collidedWith: '上一条' });
    expect(msg).toContain('重复');
    expect(msg).toContain('同一个意思只说一遍');
    // Must never look like a stack trace / internal code the model would echo to the user.
    expect(msg).not.toMatch(/Error|undefined|\[object/);
  });

  it('still renders when the probability is unknown', () => {
    expect(semanticRepeatError({ isRepeat: true, probability: null })).toContain('同一个意思只说一遍');
  });
});
