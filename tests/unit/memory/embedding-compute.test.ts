import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const f = vi.hoisted(() => ({ inputs: [] as string[], pipeline: vi.fn() }));
vi.mock('@xenova/transformers', () => ({ env: { cacheDir: '/synthetic-missing-cache' }, pipeline: f.pipeline }));
import { createLocalEmbeddingEngine } from '../../../src/memory/embedding-local.js';
import { embeddingIdentity, EMBEDDING_MAX_BODY_BYTES, legacyEmbeddingInput } from '../../../src/memory/embedding-contract.js';
import type { EmbeddingEngine } from '../../../src/memory/embedding-contract.js';
import { createEmbeddingServer } from '../../../src/compute/embedding-server.js';
import { remoteEmbeddings } from '../../../src/memory/embedding-remote.js';
import { computeEnv } from '../../../src/compute/env.js';

const TOKEN = 'synthetic-compute-token-at-least-32-characters';
const identity = embeddingIdentity('synthetic/model');
const vectors = (count: number) => Array.from({ length: count }, () => new Array<number>(384).fill(0.1));
const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function engine(fn = vi.fn(async (texts: readonly string[]) => vectors(texts.length))): EmbeddingEngine {
  return { identity, embedRawTexts: fn };
}
async function service(value = engine(), extra: { requestTimeoutMs?: number; maxConcurrent?: number } = {}) {
  return listen(createEmbeddingServer({ token: TOKEN, identity, engine: Promise.resolve(value), ...extra }));
}
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
async function post(url: string, body: unknown) {
  return fetch(url + '/v1/embeddings', { method: 'POST', headers, body: JSON.stringify(body) });
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.clearAllMocks(); f.inputs.length = 0;
});

describe('standalone embedding compute and actual HTTP failover', () => {
  it('sends raw text and applies the exact legacy length/prefix input once on both engines', async () => {
    f.pipeline.mockImplementation(async () => async (input: string, options: unknown) => {
      f.inputs.push(input); expect(options).toEqual({ pooling: 'mean', normalize: true });
      return { data: new Float32Array(384).fill(0.1) };
    });
    const raw = '原文😊' + 'x'.repeat(600);
    const local = await createLocalEmbeddingEngine({ model: identity.model });
    const remoteEngine = await createLocalEmbeddingEngine({ model: identity.model });
    const url = await service(remoteEngine);
    const remote = await remoteEmbeddings([raw], { endpoints: [url], token: TOKEN, timeoutMs: 1000, identity });
    expect(remote).toEqual(await local.embedRawTexts([raw]));
    expect(f.inputs).toEqual([legacyEmbeddingInput(raw), legacyEmbeddingInput(raw)]);
    expect(f.inputs[0]).not.toBe(legacyEmbeddingInput(legacyEmbeddingInput(raw)));
    await local.embedRawTexts([raw]); expect(f.inputs).toHaveLength(2);
  });

  it('requires bearer auth for both compute and model health, without executing on rejection', async () => {
    const call = vi.fn(async (texts: readonly string[]) => vectors(texts.length));
    const url = await service(engine(call));
    expect((await fetch(url + '/health')).status).toBe(401);
    expect((await fetch(url + '/v1/embeddings', { method: 'POST', body: 'private-canary' })).status).toBe(401);
    expect(call).not.toHaveBeenCalled();
    const health = await fetch(url + '/health', { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ready', identity, inflight: 0, maxConcurrent: 1 });
  });

  it('rejects wrong model, dimensions, preprocessing, and arbitrary fields before native execution', async () => {
    const call = vi.fn(async (texts: readonly string[]) => vectors(texts.length));
    const url = await service(engine(call));
    for (const changed of [{ model: 'other' }, { dimensions: 768 }, { preprocessing: 'other' }]) {
      expect((await post(url, { identity: { ...identity, ...changed }, texts: ['raw'] })).status).toBe(409);
    }
    expect((await post(url, { identity, texts: ['raw'], modelPath: '/etc/passwd' })).status).toBe(400);
    expect((await post(url, { identity, texts: Array(17).fill('raw') })).status).toBe(400);
    expect(call).not.toHaveBeenCalled();
  });

  it('bounds declared and chunked HTTP body sizes without invoking the model', async () => {
    const call = vi.fn(async (texts: readonly string[]) => vectors(texts.length));
    const url = await service(engine(call));
    expect((await fetch(url + '/v1/embeddings', { method: 'POST', headers, body: 'x'.repeat(EMBEDDING_MAX_BODY_BYTES + 1) })).status).toBe(413);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url + '/v1/embeddings', { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.write('x'.repeat(128 * 1024)); req.end('y'.repeat(128 * 1024 + 1));
    });
    expect(status).toBe(413); expect(call).not.toHaveBeenCalled();
  });

  it('keeps the native concurrency slot after timeout until the actual computation settles', async () => {
    let release!: (value: number[][]) => void;
    const call = vi.fn(async (_texts: readonly string[]) => vectors(1));
    call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const url = await service(engine(call), { requestTimeoutMs: 20 });
    expect((await post(url, { identity, texts: ['slow'] })).status).toBe(504);
    expect((await post(url, { identity, texts: ['next'] })).status).toBe(429);
    expect(await (await fetch(url + '/health', { headers })).json()).toMatchObject({ inflight: 1 });
    expect(call).toHaveBeenCalledTimes(1);
    release(vectors(1));
    await vi.waitFor(async () => expect(await (await fetch(url + '/health', { headers })).json()).toMatchObject({ inflight: 0 }));
    expect((await post(url, { identity, texts: ['next'] })).status).toBe(200);
  });

  it('tries configured servers in order and uses only matching identities', async () => {
    const seen: string[] = [];
    const bad = await listen(createServer((_req, res) => { seen.push('bad'); res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ identity: { ...identity, model: 'wrong' }, vectors: vectors(1) })); }));
    const good = await service(engine(vi.fn(async texts => { seen.push('good'); return vectors(texts.length); })));
    await expect(remoteEmbeddings(['raw'], { endpoints: [bad, good], token: TOKEN, identity, timeoutMs: 1000 })).resolves.toEqual(vectors(1));
    expect(seen).toEqual(['bad', 'good']);
  });

  it('never follows a redirect with the credential, and may use explicit local fallback', async () => {
    const leaked = vi.fn();
    const target = await listen(createServer((req, res) => { leaked(req.headers.authorization); res.end('{}'); }));
    const redirect = await listen(createServer((_req, res) => { res.writeHead(307, { location: target + '/v1/embeddings' }); res.end(); }));
    const local = vi.fn(async () => vectors(1));
    expect(await remoteEmbeddings(['raw'], { endpoints: [redirect], token: TOKEN, identity, timeoutMs: 1000, localFallback: local })).toEqual(vectors(1));
    expect(leaked).not.toHaveBeenCalled(); expect(local).toHaveBeenCalledWith(['raw']);
  });

  it('bounds response bytes, validates vector dimensions and never returns a mismatched vector', async () => {
    const huge = await listen(createServer((_req, res) => { res.writeHead(200, { 'content-length': String(600 * 1024) }); res.end('x'.repeat(600 * 1024)); }));
    await expect(remoteEmbeddings(['raw'], { endpoints: [huge], token: TOKEN, identity, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'embedding_response_too_large' });
    const wrong = await listen(createServer((_req, res) => { res.end(JSON.stringify({ identity, vectors: [[1, 2]] })); }));
    await expect(remoteEmbeddings(['raw'], { endpoints: [wrong], token: TOKEN, identity, timeoutMs: 1000 })).rejects.toMatchObject({ code: 'embedding_vectors_invalid' });
  });

  it('aborts timed out HTTP and fails over, without requiring the remote native job to stop', async () => {
    let release!: (vectors: number[][]) => void;
    const slow = await service(engine(vi.fn(() => new Promise(resolve => { release = resolve; }))), { requestTimeoutMs: 10_000 });
    const good = await service();
    expect(await remoteEmbeddings(['raw'], { endpoints: [slow, good], token: TOKEN, identity, timeoutMs: 100 })).toEqual(vectors(1));
    expect(await (await fetch(slow + '/health', { headers })).json()).toMatchObject({ inflight: 1 });
    release(vectors(1));
  });

  it('rejects missing auth and unsafe endpoint forms without a request; local fallback remains explicit', async () => {
    const call = vi.fn();
    await expect(remoteEmbeddings(['raw'], { endpoints: ['http://user:pass@localhost/'], token: TOKEN, identity, timeoutMs: 100, fetch: call }))
      .rejects.toMatchObject({ code: 'embedding_endpoint_invalid' });
    await expect(remoteEmbeddings(['raw'], { endpoints: ['http://localhost'], token: '', identity, timeoutMs: 100, fetch: call }))
      .rejects.toMatchObject({ code: 'embedding_remote_auth_unconfigured' });
    expect(call).not.toHaveBeenCalled();
  });

  it('does not claim health-ready when model loading failed or engine identity differs', async () => {
    const url = await listen(createEmbeddingServer({ token: TOKEN, identity, engine: Promise.resolve({ ...engine(), identity: embeddingIdentity('other') }) }));
    expect((await fetch(url + '/health', { headers })).status).toBe(503);
    expect((await post(url, { identity, texts: ['raw'] })).status).toBe(503);
  });

  it('validates actual native output dimensions before the standalone engine can become ready', async () => {
    f.pipeline.mockResolvedValue(async () => ({ data: new Float32Array(768) }));
    const url = await listen(createEmbeddingServer({ token: TOKEN, identity,
      engine: createLocalEmbeddingEngine({ model: identity.model, verifyDimensions: true }) }));
    await vi.waitFor(async () => expect(await (await fetch(url + '/health', { headers })).json()).toMatchObject({ status: 'unavailable' }));
    expect((await post(url, { identity, texts: ['raw'] })).status).toBe(503);
  });

  it('parses standalone config without bot credentials and requires a fixed local model cache', () => {
    const parsed = computeEnv({ EMBED_COMPUTE_TOKEN: TOKEN, EMBED_COMPUTE_MODEL: identity.model,
      EMBED_COMPUTE_CACHE_DIR: process.cwd() });
    expect(parsed.EMBED_COMPUTE_CONCURRENCY).toBe(1);
    expect(parsed).not.toHaveProperty('BOT_TOKEN');
    expect(() => computeEnv({ EMBED_COMPUTE_TOKEN: 'short' })).toThrow();
    expect(() => computeEnv({ EMBED_COMPUTE_TOKEN: TOKEN, EMBED_COMPUTE_MODEL: '../other', EMBED_COMPUTE_CACHE_DIR: process.cwd() })).toThrow();
  });
});
