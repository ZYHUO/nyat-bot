import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const judgeMock = vi.fn();
vi.mock('../../../src/ai/judge-substrate.js', () => ({ judge: (...a: unknown[]) => judgeMock(...a) }));

const { checkUngroundedClaim, statesConcreteFact, ungroundedClaimError } = await import(
  '../../../src/subagent/grounding-check.js',
);

function stubJudge(tp: number, ua: number, backend = 'typesafe') {
  judgeMock.mockImplementation(async () => ({
    backend,
    ok: true,
    answers: {
      topic_in_chat: { kind: 'noul', value: tp, probability: tp, confidence: null },
      user_asked: { kind: 'noul', value: ua, probability: ua, confidence: null },
    },
  }));
}

// The real incident: a content-free message and a 1.5h-old content-free anchor;
// the chat's last real topic was ribs and a checkin bot. Reply invented a price.
const INCIDENT_CANDIDATE = '2698 换块屏，苹果这刀法确实狠喵';
const INCIDENT_CONTEXT = [
  '用户: 又沾一身的油烟味了',
  'bot: 哈哈做饭哪有不沾点油烟味的 好吃就值了',
  '用户: 昨天买的20块钱排骨，好嫩',
  'bot: 20块这品质血赚啊，怎么做的喵',
  '用户: /qd',
  '用户: （想到瞭不好的東西）',
];
const INCIDENT_DIRECTION = '（想到瞭不好的東西）';

beforeEach(() => { judgeMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('statesConcreteFact — deterministic gate before any model call', () => {
  it('fires on prices, amounts and multi-digit numbers', () => {
    for (const t of [
      '2698 换块屏，苹果这刀法确实狠喵',
      '这玩意 36.4 元',
      '花了 1200 块',
      '1299元入手',
    ]) {
      expect(statesConcreteFact(t), t).toBe(true);
    }
  });

  it('stays quiet on casual chat with no assertion', () => {
    for (const t of ['什么——', '确实狠', '笨死了喵', '她说她好好看', '6-2=4，这题也太简单了点喵']) {
      expect(statesConcreteFact(t), t).toBe(false);
    }
  });
});

describe('checkUngroundedClaim', () => {
  it('flags the production hallucination (topic absent AND not asked)', async () => {
    stubJudge(0.02, 0.01);
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(true);
    expect(r.topicPresent).toBe(0.02);
  });

  it('lets a grounded answer through (topic actually discussed)', async () => {
    stubJudge(0.95, 0.4);
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
  });

  it('lets an unsolicited-but-asked answer through (user asked about it)', async () => {
    stubJudge(0.05, 0.92);
    const r = await checkUngroundedClaim(
      '苹果官方换屏 2698 起，看型号',
      INCIDENT_CONTEXT,
      '苹果换屏多少钱',
    );
    expect(r.ungrounded).toBe(false);
  });

  it('does not call the substrate when the candidate has no concrete number', async () => {
    stubJudge(0.01, 0.01);
    const r = await checkUngroundedClaim('确实狠', INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it('does not call the substrate when there is no chat context', async () => {
    stubJudge(0.01, 0.01);
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, [], INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it('fails open when the substrate reports failure', async () => {
    judgeMock.mockImplementation(async () => ({ backend: 'chat', ok: false, answers: { topic_in_chat: null, user_asked: null } }));
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(r.topicPresent).toBeNull();
  });

  it('asks both questions in one call (speculative fan-out)', async () => {
    stubJudge(0.02, 0.01);
    await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(judgeMock).toHaveBeenCalledTimes(1);
    const call = judgeMock.mock.calls[0]?.[0];
    expect(Object.keys(call.questions)).toEqual(['topic_in_chat', 'user_asked']);
    expect(call.key).toBe('grounding_claim');
  });
});

describe('ungroundedClaimError', () => {
  it('tells the model what to do instead, not just that it failed', () => {
    const msg = ungroundedClaimError();
    expect(msg).toContain('不要凭空断言');
    expect(msg).toContain('问一句');
    expect(msg).not.toMatch(/Error|undefined|\[object/);
  });
});
