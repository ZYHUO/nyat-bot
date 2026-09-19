import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// grounding-check 依赖 env()（开关+阈值+端点）和全局 fetch（TypeSafe System One）。
const envMock = {
  GROUNDING_CHECK_ENABLED: true,
  GROUNDING_PRESENT_MAX: 0.35,
  GROUNDING_ASKED_MAX: 0.35,
  TYPESAFE_API_KEY: 'test-key',
  TYPESAFE_ENDPOINT: 'https://api.typesafe.ai/v1/systemone',
  TYPESAFE_MODEL: 'jev-latest',
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const { checkUngroundedClaim, statesConcreteFact, ungroundedClaimError } = await import(
  '../../../src/subagent/grounding-check.js'
);

// The real incident: a content-free message 「（想到瞭不好的東西）」 and a 1.5h-old
// content-free anchor 「她好好看——」; the chat's last real topic was ribs and a
// checkin bot. The reply invented an Apple screen-replacement price.
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

function mockJev(answers: { topic_in_chat?: number; user_asked?: number } | null) {
  return vi.fn(async (_url: unknown, _init: unknown) => {
    if (answers === null) throw new Error('network down');
    // Real TypeSafe shape: {answers: {<name>: {noul: p}}}
    const wrapped: Record<string, { noul: number }> = {};
    for (const [k, v] of Object.entries(answers)) if (typeof v === 'number') wrapped[k] = { noul: v };
    return { ok: true, json: async () => ({ answers: wrapped }) } as unknown as Response;
  });
}

beforeEach(() => {
  envMock.GROUNDING_CHECK_ENABLED = true;
  envMock.TYPESAFE_API_KEY = 'test-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('statesConcreteFact — deterministic gate before any LLM call', () => {
  it('fires on prices, amounts and multi-digit numbers', () => {
    for (const t of [
      '2698 换块屏，苹果这刀法确实狠喵',
      '这玩意 36.4 元',
      '花了 1200 块',
      '2698',
      '1299元入手',
    ]) {
      expect(statesConcreteFact(t), t).toBe(true);
    }
  });

  it('stays quiet on casual chat with no assertion', () => {
    for (const t of [
      '什么——',
      '确实狠',
      '笨死了喵',
      '我看到了',
      '她说她好好看',
      '6-2=4，这题也太简单了点喵', // tiny numbers only — not a specific factual claim
    ]) {
      expect(statesConcreteFact(t), t).toBe(false);
    }
  });
});

describe('checkUngroundedClaim', () => {
  it('flags the production hallucination', async () => {
    vi.stubGlobal('fetch', mockJev({ topic_in_chat: 0.02, user_asked: 0.01 }));
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(true);
    expect(r.topicPresent).toBe(0.02);
  });

  it('lets a grounded answer through (topic actually discussed)', async () => {
    vi.stubGlobal('fetch', mockJev({ topic_in_chat: 0.95, user_asked: 0.4 }));
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
  });

  it('lets an unsolicited-but-asked answer through (user asked about it)', async () => {
    // Bot volunteers knowledge the user requested — legit even if not discussed before.
    vi.stubGlobal('fetch', mockJev({ topic_in_chat: 0.05, user_asked: 0.92 }));
    const r = await checkUngroundedClaim(
      '苹果官方换屏 2698 起，看型号',
      INCIDENT_CONTEXT,
      '苹果换屏多少钱',
    );
    expect(r.ungrounded).toBe(false);
  });

  it('does not even ask the model when the candidate has no concrete number', async () => {
    const fetchSpy = mockJev({ topic_in_chat: 0.01, user_asked: 0.01 });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkUngroundedClaim('确实狠', INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not ask when there is no chat context at all', async () => {
    const fetchSpy = mockJev({ topic_in_chat: 0.01, user_asked: 0.01 });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, [], INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails open when JeV is unreachable (never swallow a message on infra failure)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails open when no API key is configured', async () => {
    envMock.TYPESAFE_API_KEY = '';
    const fetchSpy = mockJev({ topic_in_chat: 0.01, user_asked: 0.01 });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(r.ungrounded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks both questions in one call (speculative fan-out, not two round-trips)', async () => {
    const fetchSpy = mockJev({ topic_in_chat: 0.02, user_asked: 0.01 });
    vi.stubGlobal('fetch', fetchSpy);
    await checkUngroundedClaim(INCIDENT_CANDIDATE, INCIDENT_CONTEXT, INCIDENT_DIRECTION);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(Object.keys(body.questions)).toEqual(['topic_in_chat', 'user_asked']);
  });
});

describe('ungroundedClaimError', () => {
  it('tells the model what to do instead, not just that it failed', () => {
    const msg = ungroundedClaimError();
    expect(msg).toContain('不要凭空断言');
    expect(msg).toContain('用户也没在问');
    // The model must be given a way out, not trapped.
    expect(msg).toContain('问一句');
    expect(msg).not.toMatch(/Error|undefined|\[object/);
  });
});
