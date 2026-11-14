import { join } from 'node:path';
import { LRUCache } from 'lru-cache';
import { embeddingIdentity, legacyEmbeddingInput, validEmbeddingVectors } from './embedding-contract.js';
import type { EmbeddingEngine } from './embedding-contract.js';
import { findEmbedOnnxWeights, findMissingEmbedJson } from './embedding-weights.js';

export interface LocalEmbeddingOptions {
  model: string;
  cacheDir?: string;
  localOnly?: boolean;
  verifyDimensions?: boolean;
  onWarning?: (fields: Record<string, unknown>, message: string) => void;
}

/** No bot configuration, credentials, SQLite or Redis dependency. */
export async function createLocalEmbeddingEngine(options: LocalEmbeddingOptions): Promise<EmbeddingEngine> {
  const { pipeline, env: xenovaEnv } = await import('@xenova/transformers');
  if (options.cacheDir) xenovaEnv.cacheDir = options.cacheDir;
  const modelDir = join(xenovaEnv.cacheDir, options.model);
  const onnxDir = join(modelDir, 'onnx');
  const weights = findEmbedOnnxWeights(onnxDir), missingJson = findMissingEmbedJson(modelDir);
  const fullyLocal = weights !== null && missingJson.length === 0;
  if (options.localOnly && !fullyLocal) throw new Error('embedding_local_artifacts_missing');
  if (!weights) options.onWarning?.({ model: options.model, onnxDir },
    'Memory embedding weights are NOT in the local cache — embedding will download them. Fix once: npx tsx scripts/fetch-embed-model.mts');
  else if (missingJson.length > 0) options.onWarning?.({ model: options.model, modelDir, missingJson },
    'Memory embedding weights are cached but tokenizer/config JSON is missing — staying online so they can download. Fix once: npx tsx scripts/fetch-embed-model.mts');
  const extractor = await pipeline('feature-extraction', options.model, {
    progress_callback: undefined, ...(fullyLocal ? { local_files_only: true } : {}),
  });
  const cache = new LRUCache<string, number[]>({ max: 200, ttl: 5 * 60 * 1000 });
  const engine: EmbeddingEngine = { identity: embeddingIdentity(options.model),
    async embedRawTexts(rawTexts) {
      const vectors: number[][] = [];
      for (const text of rawTexts) {
        const input = legacyEmbeddingInput(text);
        let vector = cache.get(input);
        if (!vector) {
          const output = await extractor(input, { pooling: 'mean', normalize: true });
          vector = Array.from(output.data as Float32Array);
          cache.set(input, vector);
        }
        vectors.push(vector);
      }
      return vectors;
    },
  };
  if (options.verifyDimensions) {
    const probe = await engine.embedRawTexts(['embedding-dimension-probe']);
    if (!validEmbeddingVectors(probe, 1)) throw new Error('embedding_native_dimensions_mismatch');
  }
  return engine;
}
