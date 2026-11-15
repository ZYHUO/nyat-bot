import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = {
  JUDGE_SUBSTRATE_ENABLED: true,
  JUDGE_SUBSTRATE_BACKEND: 'typesafe',
  JUDGE_SUBSTRATE_TIMEOUT_MS: 3000,
  JUDGE_SUBSTRATE_CACHE_TTL_MS: 120000,
  JUDGE_SUBSTRATE_BREAKER_FAILS: 3,
  JUDGE_SUBSTRATE_BREAKER_COOLDOWN_MS: 60000,
  TYPESAFE_API_KEY: 'k',
  TYPESAFE_ENDPOINT: 'https://api.typesafe.ai/v1/systemone',
  TYPESAFE_MODEL: 'jev-latest',
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const fallbackMock = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...a: unknown[]) => fallbackMock(...a) }));

const llmEvents = (await import('../../../src/ai/events.js')).llmEvents;
const { judge, resetJudgmentState } = await import('../../../src/ai/judge-substrate.js');

function stubTypesafe(answers: Record<string, unknown> | null, usage = { input_tokens: 300, output_tokens: 20 }) {
  return vi.fn(async () => {
    if (answers === null) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ answers, usage }) } as unknown as Response;
  });
}

beforeEach(() => {
  envMock.JUDGE_SUBSTRATE_ENABLED = true;
  envMock.JUDGE_SUBSTRATE_BACKEND = 'typesafe';
  envMock.TYPESAFE_API_KEY = 'k';
  resetJudgmentState();
  fallbackMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOUL = { same: { kind: 'noul', question: '是不是同一个意思？' } };

describe('judge — typesafe backend', () => {
  it('parses the real noul answer shape', async () => {
    vi.stubGlobal('fetch', stubTypesafe({ same: { type: 'noul', noul: 0.68, confidence: 0.9 } }));
    const r = await judge({ key: 'k1', state: 'A: 1\nB: 2', questions: NOUL });
    expect(r.ok).toBe(true);
    expect(r.backend).toBe('typesafe');
    expect(r.answers.same).toEqual({ kind: 'noul', value: 0.68, probability: 0.68, confidence: 0.9 });
  });

  it('parses choice (choice + confidence + probabilities) and score (score + confidence)', async () => {
    vi.stubGlobal('fetch', stubTypesafe({
      act: { type: 'choice', choice: 'pass', confidence: 0.1, probabilities: { reply: 0.38, wait: 0.22, pass: 0.4 } },
      mood: { type: 'score', score: 1.02, confidence: 0.89, probabilities: { 0: 0.03, 1: 0.93, 2: 0.04 } },
    }));
    const r = await judge({
      key: 'k2',
      state: 's',
      questions: {
        act: { kind: 'choice', question: '该怎么做', options: { wait: '等等', reply: '回一句', pass: '不管' } },
        mood: { kind: 'score', question: '多不耐烦', levels: ['没什么', '有点', '很烦'] },
      },
    });
    expect(r.answers.act).toEqual({ kind: 'choice', value: 'pass', probability: 0.4, confidence: 0.1 });
    expect(r.answers.mood?.value).toBeCloseTo(1.02);
    expect(r.answers.mood?.probability).toBeCloseTo(0.93);
  });

  it('sends score levels as an ordered criteria LIST (the API requires a list)', async () => {
    const spy = stubTypesafe({ mood: { type: 'score', score: 1, confidence: 0.5, probabilities: { 0: 0.1, 1: 0.8 } } });
    vi.stubGlobal('fetch', spy);
    await judge({ key: 'k3', state: 's', questions: { mood: { kind: 'score', question: 'q', levels: ['低', '中', '高'] } } });
    const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.questions.mood.criteria).toEqual(['低', '中', '高']);
    expect(body.questions.mood.type).toBe('score');
  });

  it('reports token usage on the llmEvents bus (so llm_token_daily sees it)', async () => {
    vi.stubGlobal('fetch', stubTypesafe({ same: { type: 'noul', noul: 0.5 } }));
    const seen: unknown[] = [];
    llmEvents.on('result', (e) => seen.push(e));
    await judge({ key: 'k4', state: 's', questions: NOUL });
    llmEvents.removeAllListeners('result');
    const ev = seen.find((e) => (e as { usage: string }).usage === 'judgment') as
      | { promptTokens: number; completionTokens: number; label: string }
      | undefined;
    expect(ev).toBeTruthy();
    expect(ev?.promptTokens).toBe(300);
    expect(ev?.completionTokens).toBe(20);
  });
});

describe('judge — privacy rule', () => {
  it('DM (chatId>0) must never go to the external judge service', async () => {
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.9 } });
    vi.stubGlobal('fetch', spy);
    fallbackMock.mockResolvedValue({ content: '{"same":{"value":0.9}}' });
    const r = await judge({ key: 'k5', state: 's', questions: NOUL, chatId: 6251541967 });
    expect(spy).not.toHaveBeenCalled();
    expect(r.backend).toBe('chat');
  });

  it('private visibility falls back to the existing chain too', async () => {
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.9 } });
    vi.stubGlobal('fetch', spy);
    fallbackMock.mockResolvedValue({ content: '{"same":{"value":0.9}}' });
    const r = await judge({ key: 'k6', state: 's', questions: NOUL, visibility: 'private' });
    expect(spy).not.toHaveBeenCalled();
    expect(r.backend).toBe('chat');
  });

  it('group traffic does use the external service', async () => {
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.9 } });
    vi.stubGlobal('fetch', spy);
    await judge({ key: 'k7', state: 's', questions: NOUL, chatId: -1002943259956 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('judge — resilience', () => {
  it('falls back to the chat backend when typesafe is unreachable', async () => {
    vi.stubGlobal('fetch', stubTypesafe(null));
    fallbackMock.mockResolvedValue({ content: '{"same":{"value":0.42}}' });
    const r = await judge({ key: 'k8', state: 's', questions: NOUL });
    expect(r.backend).toBe('chat');
    expect(r.answers.same?.value).toBe(0.42);
  });

  it('opens the breaker after N consecutive failures and stays on chat', async () => {
    vi.stubGlobal('fetch', stubTypesafe(null));
    fallbackMock.mockResolvedValue({ content: '{"same":{"value":0.1}}' });
    for (let i = 0; i < 3; i++) await judge({ key: `kb${i}`, state: 's', questions: NOUL });
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.9 } });
    vi.stubGlobal('fetch', spy);
    const r = await judge({ key: 'kb3', state: 's', questions: NOUL });
    expect(r.backend).toBe('chat');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns ok:false (fail-open) when every backend fails', async () => {
    vi.stubGlobal('fetch', stubTypesafe(null));
    fallbackMock.mockRejectedValue(new Error('chain down'));
    const r = await judge({ key: 'k9', state: 's', questions: NOUL });
    expect(r.ok).toBe(false);
    expect(r.answers.same).toBeNull();
  });

  it('does nothing external when the substrate is disabled', async () => {
    envMock.JUDGE_SUBSTRATE_ENABLED = false;
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.9 } });
    vi.stubGlobal('fetch', spy);
    fallbackMock.mockResolvedValue({ content: '{"same":{"value":0.5}}' });
    const r = await judge({ key: 'k10', state: 's', questions: NOUL });
    expect(spy).not.toHaveBeenCalled();
    expect(r.backend).toBe('chat');
  });
});

describe('judge — cache', () => {
  it('serves an identical repeated question from cache', async () => {
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.77 } });
    vi.stubGlobal('fetch', spy);
    const a = await judge({ key: 'kc', state: 'same state', questions: NOUL });
    const b = await judge({ key: 'kc', state: 'same state', questions: NOUL });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b.backend).toBe('cache');
    expect(b.answers.same?.value).toBe(a.answers.same?.value);
  });

  it('different state is a different cache entry', async () => {
    const spy = stubTypesafe({ same: { type: 'noul', noul: 0.77 } });
    vi.stubGlobal('fetch', spy);
    await judge({ key: 'kc', state: 'state one', questions: NOUL });
    await judge({ key: 'kc', state: 'state two', questions: NOUL });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
