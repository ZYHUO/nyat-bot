import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 判断走定型判断基座（src/ai/judge-substrate.ts）。这里 mock 基座，
// 只测守卫自己的逻辑：阈值、确定性闸门、fail-open。
const judgeMock = vi.fn();
vi.mock('../../../src/ai/judge-substrate.js', () => ({ judge: (...a: unknown[]) => judgeMock(...a) }));

const { checkSemanticRepeat, semanticRepeatError, MIN_CANDIDATE_CHARS } = await import(
  '../../../src/subagent/semantic-dup.js',
);

function stubJudge(probability: number | null, backend = 'typesafe') {
  judgeMock.mockImplementation(async () => ({
    backend,
    ok: probability !== null,
    answers: {
      same: probability === null ? null : { kind: 'noul', value: probability, probability, confidence: null },
    },
  }));
}

beforeEach(() => { judgeMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

// 校准基线（36 对人工标注的真实生产配对，2026-09-19）：
//   REPEAT p=.11-.97 均值 .84   <- 同义改写落在字面守卫盲区（Jaccard 仅 0.11~0.12）
//   DIFF   p=.07-.72 均值 .27
const PARAPHRASE_PAIR = ['20块钱能买到这么嫩的排骨，血赚啊喵', '20块这品质血赚啊，怎么做的喵'];
const DISTINCT_PAIR = ['走，贴创可贴去喵', '急什么，创可贴又不会跑喵'];

describe('checkSemanticRepeat', () => {
  it('flags the sleepy-greeting variants (the production incident)', async () => {
    stubJudge(0.81);
    const r = await checkSemanticRepeat(
      ['嗯…主人还没睡呀？蹭蹭，困到连爪子都抬不起来了喵'],
      '嗯…主人也还没睡呀？本喵困到要流口水了喵',
    );
    expect(r.isRepeat).toBe(true);
    expect(r.collidedWith).toContain('困到连爪子都抬不起来');
    expect(r.backend).toBe('typesafe');
  });

  it('near-miss (0.68) stays under the 0.7 threshold — do not over-block', async () => {
    stubJudge(0.68);
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(r.probability).toBe(0.68);
  });

  it('lets a genuinely different follow-up through', async () => {
    stubJudge(0.21);
    const r = await checkSemanticRepeat([DISTINCT_PAIR[0]], DISTINCT_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(r.probability).toBe(0.21);
  });

  it('does not judge very short candidates', async () => {
    stubJudge(0.99);
    const r = await checkSemanticRepeat(['本喵不干喵'], '嗯');
    expect(r.isRepeat).toBe(false);
    expect(judgeMock).not.toHaveBeenCalled();
    expect(MIN_CANDIDATE_CHARS).toBe(8);
  });

  it('does not judge when nothing was sent before in this task', async () => {
    stubJudge(0.99);
    const r = await checkSemanticRepeat([], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it('only sends the last 3 priors, under a stable cache key', async () => {
    stubJudge(0.9);
    await checkSemanticRepeat(
      ['第一条历史消息内容足够长', '第二条历史消息内容足够长', '第三条历史消息内容足够长', '第四条历史消息内容足够长'],
      '候选消息内容在这里也足够长',
    );
    expect(judgeMock).toHaveBeenCalledTimes(1);
    const call = judgeMock.mock.calls[0]?.[0];
    expect(call.key).toBe('semantic_repeat');
    expect(call.state).toContain('第四条历史消息内容足够长');
    expect(call.state).not.toContain('第一条历史消息内容足够长');
  });

  it('fails open when the substrate reports failure (never swallow a message)', async () => {
    stubJudge(null);
    const r = await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1]);
    expect(r.isRepeat).toBe(false);
    expect(r.probability).toBeNull();
  });

  it('passes chatId through so the substrate can apply the privacy rule', async () => {
    stubJudge(0.9);
    await checkSemanticRepeat([PARAPHRASE_PAIR[0]], PARAPHRASE_PAIR[1], { chatId: 6251541967 });
    expect(judgeMock.mock.calls[0]?.[0].chatId).toBe(6251541967);
  });
});

describe('semanticRepeatError', () => {
  it('reads as a felt, actionable fact — not a system error code', () => {
    const msg = semanticRepeatError({ isRepeat: true, probability: 0.68, collidedWith: '上一条' });
    expect(msg).toContain('同一个意思只说一遍');
    expect(msg).not.toMatch(/Error|undefined|\[object/);
  });

  it('still renders when the probability is unknown', () => {
    expect(semanticRepeatError({ isRepeat: true, probability: null })).toContain('同一个意思只说一遍');
  });
});
