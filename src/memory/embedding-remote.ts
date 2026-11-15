import { EMBEDDING_MAX_BODY_BYTES, sameEmbeddingIdentity, validEmbeddingVectors, validRawEmbeddingTexts } from './embedding-contract.js';
import type { EmbeddingIdentity } from './embedding-contract.js';

export class RemoteEmbeddingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RemoteEmbeddingError'; }
}
export interface RemoteEmbeddingOptions {
  endpoints: readonly string[];
  token: string;
  timeoutMs: number;
  identity: EmbeddingIdentity;
  localFallback?: (rawTexts: readonly string[]) => Promise<number[][]>;
  fetch?: typeof fetch;
}

export function embeddingEndpoint(base: string, path = '/v1/embeddings'): URL {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) throw new RemoteEmbeddingError('embedding_endpoint_invalid');
  return new URL(path, url);
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new RemoteEmbeddingError('embedding_response_empty');
  const declared = Number(response.headers.get('content-length'));
  if (declared > 512 * 1024) { await response.body.cancel(); throw new RemoteEmbeddingError('embedding_response_too_large'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new RemoteEmbeddingError('embedding_response_too_large'); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

/** Inputs are RAW text. Only configured origins are tried; redirects are errors. */
export async function remoteEmbeddings(rawTexts: readonly string[], options: RemoteEmbeddingOptions): Promise<number[][]> {
  let lastCode = 'embedding_remote_unconfigured';
  const request = JSON.stringify({ identity: options.identity, texts: rawTexts });
  const requestValid = validRawEmbeddingTexts(rawTexts) && Buffer.byteLength(request) <= EMBEDDING_MAX_BODY_BYTES;
  if (requestValid && options.token.length >= 32) {
    // Bound a configuration typo; these are trusted settings, never tool/user URLs.
    for (const base of options.endpoints.slice(0, 4)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      try {
        const url = embeddingEndpoint(base);
        timer = setTimeout(() => abort.abort(), Math.max(100, Math.min(30_000, options.timeoutMs)));
        const response = await (options.fetch ?? fetch)(url, { method: 'POST', redirect: 'error', signal: abort.signal,
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' }, body: request });
        if (!response.ok) { await response.body?.cancel(); throw new RemoteEmbeddingError(`embedding_http_${response.status}`); }
        const payload = await boundedJson(response) as { identity?: unknown; vectors?: unknown } | null;
        if (!payload || !sameEmbeddingIdentity(payload.identity, options.identity)) throw new RemoteEmbeddingError('embedding_identity_mismatch');
        if (!validEmbeddingVectors(payload.vectors, rawTexts.length, options.identity.dimensions)) throw new RemoteEmbeddingError('embedding_vectors_invalid');
        return payload.vectors;
      } catch (error) {
        lastCode = abort.signal.aborted ? 'embedding_remote_timeout'
          : error instanceof RemoteEmbeddingError ? error.code : 'embedding_remote_unavailable';
      } finally { if (timer) clearTimeout(timer); }
    }
  } else lastCode = requestValid ? 'embedding_remote_auth_unconfigured' : 'embedding_request_too_large';
  if (options.localFallback) {
    const vectors = await options.localFallback(rawTexts);
    if (!validEmbeddingVectors(vectors, rawTexts.length, options.identity.dimensions)) throw new RemoteEmbeddingError('embedding_local_vectors_invalid');
    return vectors;
  }
  throw new RemoteEmbeddingError(lastCode);
}
