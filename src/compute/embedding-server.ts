import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EMBEDDING_MAX_BODY_BYTES, sameEmbeddingIdentity, validEmbeddingVectors, validRawEmbeddingTexts } from '../memory/embedding-contract.js';
import type { EmbeddingEngine, EmbeddingIdentity } from '../memory/embedding-contract.js';

export interface EmbeddingServerOptions {
  token: string;
  identity: EmbeddingIdentity;
  engine: Promise<EmbeddingEngine>;
  maxConcurrent?: number;
  requestTimeoutMs?: number;
}
class RequestRejected extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readRequest(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (declared > EMBEDDING_MAX_BODY_BYTES) throw new RequestRejected(413, 'request_too_large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > EMBEDDING_MAX_BODY_BYTES) throw new RequestRejected(413, 'request_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new RequestRejected(400, 'invalid_json'); }
}

/** Standalone authenticated compute. No import of bot env, state or send APIs. */
export function createEmbeddingServer(options: EmbeddingServerOptions) {
  if (options.token.length < 32) throw new Error('embedding_compute_token_too_short');
  const tokenDigest = createHash('sha256').update(options.token).digest();
  const maxConcurrent = Math.max(1, Math.min(4, Math.floor(options.maxConcurrent ?? 1)));
  const timeout = Math.max(10, Math.min(30_000, options.requestTimeoutMs ?? 15_000));
  let engine: EmbeddingEngine | undefined, unavailable = false, inflight = 0;
  const active = new Map<symbol, number>();
  void options.engine.then(value => {
    if (!sameEmbeddingIdentity(value.identity, options.identity)) throw new Error('embedding_engine_identity_mismatch');
    engine = value;
  }).catch(() => { unavailable = true; });

  const server = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.length > 512
        || !timingSafeEqual(tokenDigest, createHash('sha256').update(auth.slice(7)).digest())) {
        req.resume(); reply(res, 401, { error: 'unauthorized' }); return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        reply(res, engine ? 200 : 503, { status: engine ? 'ready' : unavailable ? 'unavailable' : 'loading',
          identity: options.identity, inflight, maxConcurrent,
          oldestActiveMs: active.size ? Date.now() - Math.min(...active.values()) : null }); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') { req.resume(); reply(res, 404, { error: 'not_found' }); return; }
      if (!engine) { req.resume(); reply(res, 503, { error: 'engine_unavailable' }); return; }
      if (inflight >= maxConcurrent) { req.resume(); reply(res, 429, { error: 'compute_busy' }); return; }
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new RequestRejected(415, 'json_required');
      const body = await readRequest(req) as { identity?: unknown; texts?: unknown } | null;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['identity', 'texts'].includes(key)) || !validRawEmbeddingTexts(body.texts)) throw new RequestRejected(400, 'invalid_embedding_request');
      if (!sameEmbeddingIdentity(body.identity, options.identity)) throw new RequestRejected(409, 'identity_mismatch');
      // Concurrent body readers can arrive after the first capacity check.
      if (inflight >= maxConcurrent) { reply(res, 429, { error: 'compute_busy' }); return; }
      const slot = Symbol(); inflight++; active.set(slot, Date.now());
      const texts = body.texts;
      const deadline = setTimeout(() => reply(res, 504, { error: 'compute_timeout' }), timeout);
      // Do not release capacity on client disconnect/deadline: native inference
      // may still be consuming CPU/RAM. Only actual settlement frees the slot.
      try {
        const vectors = await engine.embedRawTexts(texts);
        if (!validEmbeddingVectors(vectors, texts.length, options.identity.dimensions)) throw new Error('invalid_vectors');
        reply(res, 200, { identity: options.identity, vectors });
      } catch { reply(res, 503, { error: 'compute_failed' }); }
      finally { clearTimeout(deadline); inflight--; active.delete(slot); }
    })().catch(error => {
      if (error instanceof RequestRejected) { req.resume(); reply(res, error.status, { error: error.code }); }
      else reply(res, 400, { error: 'request_failed' });
    });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
