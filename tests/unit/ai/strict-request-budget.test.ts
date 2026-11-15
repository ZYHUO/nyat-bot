import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AILabel } from '../../../src/ai/types.js';
const f = vi.hoisted(() => ({ labels: {} as Record<string, AILabel>, backups: ['b', 'c'], cooling: false,
  recordFailure: vi.fn(async () => false), hedgeDelay: 5, acquired: vi.fn(async () => {}) }));
vi.mock('../../../src/ai/labels.js', () => ({ getUsage: () => ({ label: 'a', backups: f.backups, timeout: 1000, maxTokens: 5000 }), getLabel: (name: string) => f.labels[name] }));
vi.mock('../../../src/ai/smart-group.js', () => ({ isAutoAssignEnabled: () => false, smartGroupAutoAssign: async () => [],
  smartGroupReorder: async (names: string[]) => names, recordSmartGroupResult: async () => {} }));
vi.mock('../../../src/ai/cooldown.js', () => ({ CooldownTracker: class {
  isCoolingDown = async () => f.cooling; getRemainingSeconds = async () => f.cooling ? 1 : 0;
  recordSuccess = async () => {}; recordFailure = f.recordFailure; setCooldown = async () => {};
} }));
vi.mock('../../../src/ai/concurrency.js', () => ({ AI_MAX_CONCURRENCY_PER_ACCOUNT: 7,
  acquireConcurrency: async () => { await f.acquired(); return () => {}; } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ incr: async () => 1, decr: async () => 0, expire: async () => 1 }) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ AI_WORKLOAD_BUDGET_ENABLED: false, AI_MAX_INFLIGHT_PER_MODEL: 8, HEDGE_DELAY_MS: f.hedgeDelay }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));
import { callWithFallback } from '../../../src/ai/fallback.js';
import { callModel, __resetTruncatingLabelsForTest } from '../../../src/ai/provider.js';

const base = { usage: 'synthetic-budget', messages: [{ role: 'user' as const, content: 'synthetic budget test' }] };
const servers: Server[] = [];
const requests: { url: string; body: Record<string, unknown> }[] = [];
type Handler = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
async function listen(handle: Handler): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
      requests.push({ url: req.url ?? '', body }); handle(req, res, body);
    })().catch(() => res.destroy());
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
}
function success(res: ServerResponse) { json(res, { id: 'synthetic', object: 'chat.completion', created: 1, model: 'model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); }
function labels(origin: string, sdk = false) {
  for (const name of ['a', 'b', 'c']) f.labels[name] = { name, model: `model-${name}`, endpoint: `${origin}/${name}/v1`, apiKeys: ['synthetic-not-a-credential'], forceRaw: !sdk, maxTokens: 9000 };
}
beforeEach(() => {
  requests.length = 0; f.backups = ['b', 'c']; f.cooling = false; f.hedgeDelay = 5;
  f.recordFailure.mockClear(); f.acquired.mockReset().mockResolvedValue(undefined); __resetTruncatingLabelsForTest();
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe('strict request budget through real fallback + provider + localhost HTTP', () => {
  it('bounds a three-provider failing chain to two actual requests and never raises the caller token cap', async () => {
    labels(await listen((_req, res) => json(res, { error: 'synthetic failure' }, 500)));
    const consume = vi.fn(async () => {});
    await expect(callWithFallback({ ...base, maxTokens: 600, beforeProviderRequest: consume })).rejects.toMatchObject({ code: 'AI_REQUEST_BUDGET_EXHAUSTED' });
    expect(requests.map(r => r.url)).toEqual(['/a/v1/chat/completions', '/b/v1/chat/completions']);
    expect(requests.map(r => r.body.max_tokens)).toEqual([600, 600]); expect(consume).toHaveBeenCalledTimes(2);
  });
  it('does not raise Claude reasoning to 4000 or issue an invisible truncated-content retry', async () => {
    labels(await listen((req, res) => {
      if (req.url?.startsWith('/a/')) json(res, { content: [{ type: 'thinking', text: 'hidden' }], model: 'step-test',
        stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1200 } });
      else success(res);
    }));
    f.labels.a = { ...f.labels.a!, model: 'step-test', apiFormat: 'claude' };
    const consume = vi.fn(async () => {});
    expect((await callWithFallback({ ...base, beforeProviderRequest: consume, rejectEmpty: true })).content).toBe('ok');
    expect(requests.map(r => r.url)).toEqual(['/a/v1/messages', '/b/v1/chat/completions']);
    expect(requests.map(r => r.body.max_tokens)).toEqual([1200, 1200]); expect(consume).toHaveBeenCalledTimes(2);
  });
  it('uses the real SDK fetch hook, disables SDK implicit retries, and consumes each fallback request once', async () => {
    labels(await listen((req, res) => req.url?.startsWith('/a/') ? json(res, { error: { message: 'temporary' } }, 503) : success(res)), true);
    const consume = vi.fn(async () => {});
    expect((await callWithFallback({ ...base, beforeProviderRequest: consume })).content).toBe('ok');
    expect(requests.map(r => r.url)).toEqual(['/a/v1/chat/completions', '/b/v1/chat/completions']);
    expect(consume).toHaveBeenCalledTimes(2); expect(requests.every(r => r.body.max_tokens === 1200)).toBe(true);
  });
  it('a persistent CAS refusal reaches no raw or SDK transport and does not poison model cooldown', async () => {
    labels(await listen((_req, res) => success(res)), true);
    const consume = vi.fn(async () => { throw new Error('synthetic CAS lost'); });
    await expect(callWithFallback({ ...base, beforeProviderRequest: consume })).rejects.toMatchObject({ code: 'AI_REQUEST_BUDGET_DENIED' });
    expect(requests).toHaveLength(0); expect(consume).toHaveBeenCalledTimes(1); expect(f.recordFailure).not.toHaveBeenCalled();
  });
  it('never launches a hedge even when explicitly requested, and admits only after async CAS finishes', async () => {
    let release!: () => void;
    labels(await listen((_req, res) => success(res)));
    const consume = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = callWithFallback({ ...base, allowHedge: true, beforeProviderRequest: consume });
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(requests).toHaveLength(0); expect(consume).toHaveBeenCalledTimes(1);
    release(); expect((await pending).content).toBe('ok'); expect(requests).toHaveLength(1);
  });
  it('deadline while CAS is pending returns immediately and late CAS success never sends', async () => {
    let release!: () => void; const abort = new AbortController();
    labels(await listen((_req, res) => success(res)));
    const consume = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const result = callWithFallback({ ...base, signal: abort.signal, beforeProviderRequest: consume }).catch(error => error);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
    abort.abort(new DOMException('attempt expired', 'TimeoutError'));
    expect(await result).toMatchObject({ code: 'AI_REQUEST_BUDGET_DEADLINE' });
    release(); await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toHaveLength(0);
  });
  it('absolute deadline aborts an in-flight request without consuming a backup', async () => {
    labels(await listen(() => {})); const abort = new AbortController(); const consume = vi.fn(async () => {});
    const result = callWithFallback({ ...base, signal: abort.signal, beforeProviderRequest: consume }).catch(error => error);
    await vi.waitFor(() => expect(requests).toHaveLength(1)); abort.abort(new DOMException('expired', 'TimeoutError'));
    expect(await result).toMatchObject({ code: 'AI_REQUEST_BUDGET_DEADLINE' });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(requests).toHaveLength(1); expect(consume).toHaveBeenCalledOnce();
  });
  it('unknown response loss consumes its slot and permits at most the one remaining request', async () => {
    labels(await listen((_req, res) => res.destroy())); const consume = vi.fn(async () => {});
    await expect(callWithFallback({ ...base, beforeProviderRequest: consume })).rejects.toMatchObject({ code: 'AI_REQUEST_BUDGET_EXHAUSTED' });
    expect(requests).toHaveLength(2); expect(consume).toHaveBeenCalledTimes(2);
  });
  it('strict redirect cannot create an unmetered second HTTP request', async () => {
    const destination = await listen((_req, res) => success(res));
    labels(await listen((_req, res) => { res.writeHead(307, { location: destination + '/redirect-destination' }); res.end(); }));
    const consume = vi.fn(async () => {});
    await expect(callWithFallback({ ...base, beforeProviderRequest: consume })).rejects.toThrow();
    expect(requests).toHaveLength(2); expect(requests.some(r => r.url === '/redirect-destination')).toBe(false);
  });
  it('all cooling means zero request/consumption and no opt-in cooling wait', async () => {
    labels(await listen((_req, res) => success(res))); f.cooling = true;
    const consume = vi.fn(async () => {});
    await expect(callWithFallback({ ...base, beforeProviderRequest: consume, waitIfCooling: true })).rejects.toMatchObject({ code: 'AI_ALL_FAILED' });
    expect(requests).toHaveLength(0); expect(consume).not.toHaveBeenCalled();
  });
  it('already-expired calls and account-queue expiration never consume or send', async () => {
    labels(await listen((_req, res) => success(res)));
    const abort = new AbortController(); abort.abort(); const consume = vi.fn(async () => {});
    await expect(callWithFallback({ ...base, signal: abort.signal, beforeProviderRequest: consume })).rejects.toMatchObject({ code: 'AI_REQUEST_BUDGET_DEADLINE' });
    const queued = new AbortController(); f.acquired.mockImplementationOnce(async () => queued.abort());
    await expect(callWithFallback({ ...base, signal: queued.signal, beforeProviderRequest: consume })).rejects.toMatchObject({ code: 'AI_REQUEST_BUDGET_DEADLINE' });
    expect(requests).toHaveLength(0); expect(consume).not.toHaveBeenCalled();
  });
  it('enforces a total 45-second deadline even if the caller supplies no signal', async () => {
    vi.useFakeTimers(); labels('http://127.0.0.1:1');
    const consume = vi.fn(() => new Promise<void>(() => {}));
    const result = callWithFallback({ ...base, beforeProviderRequest: consume }).catch(error => error);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(await result).toMatchObject({ code: 'AI_REQUEST_BUDGET_DEADLINE' }); expect(requests).toHaveLength(0);
  });
  it('without the hook, the existing Claude floor and truncated-content retry remain unchanged', async () => {
    labels(await listen((_req, res) => {
      if (requests.length === 1) json(res, { content: [], model: 'step-test', stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 4000 } });
      else json(res, { content: [{ type: 'text', text: 'legacy ok' }], model: 'step-test', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    }));
    const result = await callModel({ ...f.labels.a!, model: 'step-test', apiFormat: 'claude' }, base.messages, { maxTokens: 100 });
    expect(result.content).toBe('legacy ok'); expect(requests.map(r => r.body.max_tokens)).toEqual([4000, 8000]);
  });
});
