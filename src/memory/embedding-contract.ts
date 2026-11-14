export const EMBEDDING_PREPROCESSING = 'legacy-length-prefix512-v1' as const;
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MAX_TEXTS = 16;
export const EMBEDDING_MAX_TEXT_CHARS = 16_384;
export const EMBEDDING_MAX_BODY_BYTES = 256 * 1024;
export interface EmbeddingIdentity {
  model: string;
  dimensions: 384;
  preprocessing: typeof EMBEDDING_PREPROCESSING;
  pooling: 'mean';
  normalize: true;
}
export interface EmbeddingEngine {
  readonly identity: EmbeddingIdentity;
  /** RAW text; preprocessing belongs to the engine, exactly once. */
  embedRawTexts(texts: readonly string[]): Promise<number[][]>;
}
export function embeddingIdentity(model: string): EmbeddingIdentity {
  return { model, dimensions: EMBEDDING_DIMENSIONS, preprocessing: EMBEDDING_PREPROCESSING, pooling: 'mean', normalize: true };
}
export function sameEmbeddingIdentity(actual: unknown, expected: EmbeddingIdentity): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const value = actual as Record<string, unknown>;
  return Object.keys(value).length === 5 && value['model'] === expected.model && value['dimensions'] === expected.dimensions
    && value['preprocessing'] === expected.preprocessing && value['pooling'] === expected.pooling && value['normalize'] === expected.normalize;
}
/** Preserve the exact existing engine input, including the length prefix.
 * Correcting this historical representation requires a separate reindex.
 */
export function legacyEmbeddingInput(rawText: string): string { return `${rawText.length}:${rawText.slice(0, 512)}`; }
export function validRawEmbeddingTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= EMBEDDING_MAX_TEXTS
    && value.every(text => typeof text === 'string' && text.length > 0 && text.length <= EMBEDDING_MAX_TEXT_CHARS);
}
export function validEmbeddingVectors(value: unknown, count: number, dimensions = EMBEDDING_DIMENSIONS): value is number[][] {
  return Array.isArray(value) && value.length === count && value.every(vector => Array.isArray(vector)
    && vector.length === dimensions && vector.every(number => typeof number === 'number' && Number.isFinite(number)));
}
