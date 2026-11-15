import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createEmbeddingServer } from '../../../src/compute/embedding-server.js';
import { embeddingIdentity, legacyEmbeddingInput } from '../../../src/memory/embedding-contract.js';

const f = vi.hoisted(() => ({ pipeline: vi.fn(), cfg: {
  MEMORY_EMBED_MODEL: 'routing/model', MEMORY_REMOTE_EMBED_ENABLED: true,
  MEMORY_REMOTE_EMBED_ENDPOINTS: [] as string[], MEMORY_REMOTE_EMBED_TOKEN: 'synthetic-routing-token-at-least-32',
  MEMORY_REMOTE_EMBED_TIMEOUT_MS: 2000, MEMORY_REMOTE_EMBED_LOCAL_FALLBACK: false,
} }));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('@xenova/transformers', () => ({ env: { cacheDir: '/nonexistent-synthetic-cache' }, pipeline: f.pipeline }));
let server: Server | undefined;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  f.cfg.MEMORY_REMOTE_EMBED_ENABLED = true; f.cfg.MEMORY_REMOTE_EMBED_LOCAL_FALLBACK = false;
  f.cfg.MEMORY_REMOTE_EMBED_ENDPOINTS = [];
  f.cfg.MEMORY_EMBED_MODEL = 'routing/model';
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
});

it('the actual bot embedder selects HTTP without loading native weights and keeps the bounded cache', async () => {
  const call = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array<number>(384).fill(0.1)));
  const identity = embeddingIdentity(f.cfg.MEMORY_EMBED_MODEL);
  server = createEmbeddingServer({ token: f.cfg.MEMORY_REMOTE_EMBED_TOKEN, identity,
    engine: Promise.resolve({ identity, embedRawTexts: call }) });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  f.cfg.MEMORY_REMOTE_EMBED_ENDPOINTS = [`http://127.0.0.1:${(server.address() as AddressInfo).port}`];
  const { getMemoryEmbedder } = await import('../../../src/memory/embedding.js');
  const embed = await getMemoryEmbedder();
  const first = await embed(['主流程原文']);
  expect(await (await getMemoryEmbedder())(['主流程原文'])).toEqual(first);
  expect(call).toHaveBeenCalledExactlyOnceWith(['主流程原文']);
  expect(f.pipeline).not.toHaveBeenCalled();
});

it('explicit local fallback preserves the configured model and legacy preprocessing', async () => {
  f.cfg.MEMORY_REMOTE_EMBED_LOCAL_FALLBACK = true;
  const native = vi.fn(async () => ({ data: new Float32Array(384).fill(0.2) }));
  f.pipeline.mockResolvedValue(native);
  const { getMemoryEmbedder } = await import('../../../src/memory/embedding.js');
  await (await getMemoryEmbedder())(['回退原文']);
  expect(f.pipeline.mock.calls[0]?.slice(0, 2)).toEqual(['feature-extraction', 'routing/model']);
  expect(native).toHaveBeenCalledWith(legacyEmbeddingInput('回退原文'), { pooling: 'mean', normalize: true });
});

it('disabled remote routing keeps the existing local behavior', async () => {
  f.cfg.MEMORY_REMOTE_EMBED_ENABLED = false;
  const native = vi.fn(async () => ({ data: new Float32Array(384).fill(0.3) }));
  f.pipeline.mockResolvedValue(native);
  const { getMemoryEmbedder } = await import('../../../src/memory/embedding.js');
  expect(await (await getMemoryEmbedder())(['普通原文'])).toHaveLength(1);
  expect(native).toHaveBeenCalledOnce();
});

it('refuses hot model changes instead of silently mixing vector spaces', async () => {
  const { getMemoryEmbedder } = await import('../../../src/memory/embedding.js');
  await getMemoryEmbedder();
  f.cfg.MEMORY_EMBED_MODEL = 'different/model';
  await expect(getMemoryEmbedder()).rejects.toThrow('requires_restart');
  expect(f.pipeline).not.toHaveBeenCalled();
});
