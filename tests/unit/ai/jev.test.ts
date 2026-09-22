import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// env mock 成普通对象,逐测试开关旗标(和 judge-substrate.test.ts 同一套)。
const envMock = {
  JEV_ENABLED: true,
  JEV_BASE_URL: 'https://relay.test/bot/xyz',
  JEV_API_KEY: 'test-key',
  JEV_MODEL: 'jev-1.13',
  JEV_TIMEOUT_MS: 4000,
  JEV_MIN_CONFIDENCE: 0.6,
  JEV_BREAKER_FAILS: 3,
  JEV_BREAKER_COOLDOWN_MS: 60000,
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

const { callJev, callJevChoice, callJevNoul, callJevScore, resetJevState } =
  await import('../../../src/ai/jev.js');

/** 造一个 fetch stub。answers=null → 抛网络错;否则 ok+json。 */
function stubJev(resp: unknown | null, opts?: { ok?: boolean; status?: number }) {
  return vi.fn(async () => {
    if (resp === null) throw new Error('ECONNREFUSED');
    return {
      ok: opts?.ok ?? true,
      status: opts?.status ?? 200,
      json: async () => resp,
      text: async () => JSON.stringify(resp),
    } as unknown as Response;
  });
}

beforeEach(() => {
  envMock.JEV_ENABLED = true;
  resetJevState();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('jev — happy parsing (真实 relay 形状)', () => {
  it('choice: choice + confidence + probabilities[choice]', async () => {
    vi.stubGlobal('fetch', stubJev({
      answers: { ROUTE: { type: 'choice', choice: 'c0', confidence: 0.9, probabilities: { c0: 0.9, __none__: 0.1 } } },
      usage: { input_tokens: 340, output_tokens: 8 },
    }));
    const a = await callJevChoice({ id: 'ROUTE', state: '查下 1.1.1.1', question: '借哪条?', criteria: { c0: '/geo', __none__: 'none' } });
    expect(a).toEqual({ type: 'choice', choice: 'c0', confidence: 0.9, probability: 0.9 });
  });

  it('noul: p(yes),没有独立 confidence 字段', async () => {
    vi.stubGlobal('fetch', stubJev({ answers: { IS_Q: { type: 'noul', noul: 0.08 } } }));
    const a = await callJevNoul({ id: 'IS_Q', state: 'asdf', question: '是问句吗?' });
    expect(a).toEqual({ type: 'noul', probability: 0.08 });
  });

  it('score: 0-indexed 分值 + confidence', async () => {
    vi.stubGlobal('fetch', stubJev({
      answers: { U: { type: 'score', score: 3.24, confidence: 0.74, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd', 4: 'e' }, probabilities: { 3: 0.68, 4: 0.28 } } },
    }));
    const a = await callJevScore({ id: 'U', state: '急', question: '多急', levels: ['不急', '有点', '一般', '很急', '炸了'] });
    expect(a).toEqual({ type: 'score', score: 3.24, confidence: 0.74 });
  });

  it('请求体形状:打 /v1/systemone,choice 的 criteria 是对象、score 的是有序数组', async () => {
    const spy = stubJev({
      answers: {
        R: { type: 'choice', choice: 'c0', confidence: 0.8 },
        U: { type: 'score', score: 1, confidence: 0.5 },
      },
    });
    vi.stubGlobal('fetch', spy);
    await callJev({
      state: '状态',
      questions: {
        R: { type: 'choice', instructions: '借哪条', criteria: { c0: '/geo', __none__: 'none' } },
        U: { type: 'score', instructions: '多急', criteria: ['低', '中', '高'] },
      },
    });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.test/bot/xyz/v1/systemone');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('jev-1.13');
    expect(body.questions.R).toEqual({ type: 'choice', instructions: '借哪条', criteria: { c0: '/geo', __none__: 'none' } });
    expect(body.questions.U).toEqual({ type: 'score', instructions: '多急', criteria: ['低', '中', '高'] });
  });
});

describe('jev — fail-open (任何失败都返 null,调用方降级)', () => {
  it('HTTP 非 2xx → null', async () => {
    vi.stubGlobal('fetch', stubJev({ detail: [{ msg: 'x' }] }, { ok: false, status: 422 }));
    const a = await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } });
    expect(a).toBeNull();
  });

  it('响应没有 answers → null', async () => {
    vi.stubGlobal('fetch', stubJev({ error: { message: 'boom' } }));
    expect(await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } })).toBeNull();
  });

  it('乱码:答案类型对不上 / 数字缺失 → null', async () => {
    vi.stubGlobal('fetch', stubJev({ answers: { R: { type: 'noul', noul: 'NaN-字符串' } } }));
    expect(await callJevNoul({ id: 'R', state: 's', question: 'q' })).toBeNull();
  });

  it('choice 选了 criteria 之外的 key → 视作不可用 → null(不信集合外的答案)', async () => {
    const spy = stubJev({ answers: { R: { type: 'choice', choice: 'hallucinated', confidence: 0.99 } } });
    vi.stubGlobal('fetch', spy);
    expect(await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('网络错 / 超时 → null', async () => {
    vi.stubGlobal('fetch', stubJev(null));
    expect(await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } })).toBeNull();
  });

  it('多个问题里只有部分可解析 → 返回可用的那份(不是整单null)', async () => {
    vi.stubGlobal('fetch', stubJev({
      answers: { ok: { type: 'noul', noul: 0.5 } }, // bad: choice 集合外
      bad: { type: 'choice', choice: 'zzz', confidence: 0.9 },
    }));
    const r = await callJev({
      state: 's',
      questions: { ok: { type: 'noul', instructions: 'q' }, bad: { type: 'choice', instructions: 'q', criteria: { c0: '/geo' } } },
    });
    expect(r).toEqual({ ok: { type: 'noul', probability: 0.5 } });
  });
});

describe('jev — 门控 / 隐私 / 熔断', () => {
  it('JEV_ENABLED=false → null 且一次网络都不发', async () => {
    envMock.JEV_ENABLED = false;
    const spy = stubJev({ answers: { R: { type: 'noul', noul: 0.9 } } });
    vi.stubGlobal('fetch', spy);
    expect(await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('未配置 base url / key → null 且不发请求', async () => {
    envMock.JEV_BASE_URL = '';
    const spy = stubJev({ answers: {} });
    vi.stubGlobal('fetch', spy);
    expect(await callJevNoul({ id: 'R', state: 's', question: 'q' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    envMock.JEV_BASE_URL = 'https://relay.test/bot/xyz';
  });

  it('DM(chatId>0)不走外部服务', async () => {
    const spy = stubJev({ answers: { R: { type: 'noul', noul: 0.9 } } });
    vi.stubGlobal('fetch', spy);
    expect(await callJevNoul({ id: 'R', state: 's', question: 'q', chatId: 6251541967 })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('private visibility 不走外部服务', async () => {
    const spy = stubJev({ answers: { R: { type: 'noul', noul: 0.9 } } });
    vi.stubGlobal('fetch', spy);
    expect(await callJevNoul({ id: 'R', state: 's', question: 'q', visibility: 'private' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('空 questions → null', async () => {
    expect(await callJev({ state: 's', questions: {} })).toBeNull();
  });

  it('连续失败 N 次后熔断,期间不再发请求(避免每条消息都干等超时)', async () => {
    vi.stubGlobal('fetch', stubJev(null)); // 一直网络错
    for (let i = 0; i < 3; i++) {
      expect(await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } })).toBeNull();
    }
    const spy = stubJev({ answers: { R: { type: 'choice', choice: 'c0', confidence: 0.9 } } });
    vi.stubGlobal('fetch', spy); // relay 恢复了,但熔断期内也不该打
    expect(await callJevChoice({ id: 'R', state: 's', question: 'q', criteria: { c0: '/geo', __none__: 'none' } })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
