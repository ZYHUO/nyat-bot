import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { createLocalEmbeddingEngine } from './embedding-local.js';
import type { EmbeddingEngine } from './embedding-contract.js';
import { embeddingIdentity, sameEmbeddingIdentity } from './embedding-contract.js';
import { remoteEmbeddings } from './embedding-remote.js';
import { LRUCache } from 'lru-cache';
import { legacyEmbeddingInput } from './embedding-contract.js';

let local: Promise<EmbeddingEngine> | undefined;
let model: string | undefined;
const remoteCache = new LRUCache<string, number[]>({ max: 200, ttl: 5 * 60 * 1000 });
function pinnedModel(): string {
  const current = env().MEMORY_EMBED_MODEL;
  if (model !== undefined && model !== current) throw new Error('embedding_model_change_requires_restart');
  model = current;
  return current;
}
async function localEngine(): Promise<EmbeddingEngine> {
  const current = pinnedModel();
  local ??= createLocalEmbeddingEngine({ model: current, onWarning: (fields, message) => logger.warn(fields, message) })
    .then(engine => { logger.info({ model: current, dim: engine.identity.dimensions }, 'Memory embedder loaded'); return engine; })
    .catch(error => { local = undefined; throw error; });
  return local;
}

export async function getMemoryEmbedder(): Promise<(texts: string[]) => Promise<number[][]>> {
  const cfg = env();
  const fixedModel = pinnedModel();
  if (cfg.MEMORY_REMOTE_EMBED_ENABLED !== true) {
    const engine = await localEngine(); return texts => engine.embedRawTexts(texts);
  }
  const identity = embeddingIdentity(fixedModel);
  return async rawTexts => {
    const keys = rawTexts.map(text => JSON.stringify([identity, legacyEmbeddingInput(text)]));
    const cached = keys.map(key => remoteCache.get(key));
    const missing = rawTexts.map((_text, index) => index).filter(index => !cached[index]);
    if (missing.length === 0) return cached as number[][];
    const vectors = await remoteEmbeddings(missing.map(index => rawTexts[index]!), { identity,
    endpoints: cfg.MEMORY_REMOTE_EMBED_ENDPOINTS, token: cfg.MEMORY_REMOTE_EMBED_TOKEN,
    timeoutMs: cfg.MEMORY_REMOTE_EMBED_TIMEOUT_MS,
    ...(cfg.MEMORY_REMOTE_EMBED_LOCAL_FALLBACK ? { localFallback: async (texts: readonly string[]) => {
      const engine = await localEngine();
      if (!sameEmbeddingIdentity(engine.identity, identity)) throw new Error('embedding_local_identity_mismatch');
      return engine.embedRawTexts(texts);
    } } : {}),
    });
    missing.forEach((index, offset) => { const vector = vectors[offset]!; remoteCache.set(keys[index]!, vector); cached[index] = vector; });
    return cached as number[][];
  };
}
