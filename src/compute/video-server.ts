import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { VIDEO_DEADLINE_MS, VIDEO_INPUT_MAX_BYTES, VIDEO_RESPONSE_MAX_BYTES, sha256, validDigest, validFrames } from './video-contract.js';
import type { VideoFrame, VideoIdentity } from './video-contract.js';

export interface VideoServerOptions {
  token: string; identity: VideoIdentity; maxConcurrent?: number; timeoutMs?: number;
  decode: (bytes: Uint8Array, maxDurationSec: number, signal: AbortSignal) => Promise<VideoFrame[]>;
}
class Rejected extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBytes(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > VIDEO_INPUT_MAX_BYTES)) throw new Rejected(413, 'input_limit');
  const parts: Buffer[] = []; let length = 0;
  // Destroying an incomplete request on deadline also interrupts async iteration.
  const abort = () => { if (!req.complete) req.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Rejected(408, 'cancelled');
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      if (signal.aborted) throw new Rejected(408, 'cancelled');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      length += bytes.length;
      if (length > VIDEO_INPUT_MAX_BYTES) throw new Rejected(413, 'input_limit');
      parts.push(bytes);
    }
    if (length === 0) throw new Rejected(400, 'input_empty');
    return Buffer.concat(parts, length);
  } finally { signal.removeEventListener('abort', abort); }
}
/** Service has no platform IDs, URLs, filesystem paths, model keys or state API. */
export function createVideoServer(options: VideoServerOptions) {
  if (options.token.length < 32 || options.token.length > 256 || !/^[\x21-\x7e]+$/.test(options.token)) throw new Error('video_compute_token_invalid');
  const maxConcurrent = options.maxConcurrent ?? 1, timeout = options.timeoutMs ?? VIDEO_DEADLINE_MS;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2
    || !Number.isInteger(timeout) || timeout < 100 || timeout > VIDEO_DEADLINE_MS) throw new Error('video_compute_limits_invalid');
  const authDigest = createHash('sha256').update(options.token).digest();
  const active = new Map<symbol, { controller: AbortController; started: number }>();
  const drained: Array<() => void> = [];
  let stopping = false;
  const server = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.length > 512
        || !timingSafeEqual(authDigest, createHash('sha256').update(auth.slice(7)).digest())) {
        req.resume(); reply(res, 401, { error: 'unauthorized' }); return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        reply(res, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'ready', identity: options.identity,
          inflight: active.size, maxConcurrent, oldestActiveMs: active.size ? Date.now() - Math.min(...[...active.values()].map(value => value.started)) : null }); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/video/frames') { req.resume(); reply(res, 404, { error: 'not_found' }); return; }
      if (stopping) { req.resume(); reply(res, 503, { error: 'stopping' }); return; }
      if (active.size >= maxConcurrent) { req.resume(); reply(res, 429, { error: 'compute_busy' }); return; }
      if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['content-encoding'] !== undefined) throw new Rejected(415, 'raw_bytes_required');
      if (req.headers['x-nyat-video-protocol'] !== options.identity.protocol
        || req.headers['x-nyat-video-decoder'] !== options.identity.decoderSha256) throw new Rejected(409, 'identity_mismatch');
      const expected = req.headers['x-nyat-video-sha256'];
      const durationHeader = req.headers['x-nyat-video-duration'], timeoutHeader = req.headers['x-nyat-video-timeout'];
      if (!validDigest(expected) || typeof durationHeader !== 'string' || !/^\d+$/.test(durationHeader)
        || typeof timeoutHeader !== 'string' || !/^\d+$/.test(timeoutHeader)) throw new Rejected(400, 'metadata_invalid');
      const duration = Number(durationHeader), requestedTimeout = Number(timeoutHeader);
      if (!Number.isInteger(duration) || duration < 1 || duration > 300 || !Number.isInteger(requestedTimeout)
        || requestedTimeout < 1 || requestedTimeout > VIDEO_DEADLINE_MS) throw new Rejected(400, 'metadata_invalid');
      // Reserve before reading any body, bounding memory even for slow uploads.
      const slot = Symbol(), controller = new AbortController();
      active.set(slot, { controller, started: Date.now() });
      const cancel = () => controller.abort();
      const closed = () => { if (!res.writableFinished) cancel(); };
      req.once('aborted', cancel); res.once('close', closed);
      const timer = setTimeout(() => { reply(res, 504, { error: 'compute_timeout' }); cancel(); }, Math.min(timeout, requestedTimeout));
      try {
        const bytes = await readBytes(req, controller.signal);
        if (sha256(bytes) !== expected) throw new Rejected(400, 'input_hash_mismatch');
        if (controller.signal.aborted) return;
        const frames = await options.decode(bytes, duration, controller.signal);
        if (controller.signal.aborted) return;
        if (!validFrames(frames, duration)) throw new Rejected(503, 'invalid_decoder_output');
        const payload = { identity: options.identity, inputSha256: expected,
          frames: frames.map(frame => ({ png: frame.png.toString('base64'), atSeconds: frame.atSeconds })) };
        if (Buffer.byteLength(JSON.stringify(payload)) > VIDEO_RESPONSE_MAX_BYTES) throw new Rejected(503, 'output_limit');
        reply(res, 200, payload);
      } finally {
        clearTimeout(timer); req.removeListener('aborted', cancel); res.removeListener('close', closed);
        // A timeout/disconnect never releases a still-running native process.
        active.delete(slot);
        if (active.size === 0) for (const resolve of drained.splice(0)) resolve();
      }
    })().catch(error => {
      req.resume();
      reply(res, error instanceof Rejected ? error.status : 503, { error: error instanceof Rejected ? error.code : 'compute_failed' });
    });
  });
  server.maxConnections = 16;
  server.maxHeadersCount = 24;
  server.headersTimeout = 5000; server.requestTimeout = VIDEO_DEADLINE_MS; server.keepAliveTimeout = 1000;
  return { server, async stop(): Promise<void> {
    stopping = true;
    for (const value of active.values()) value.controller.abort();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    if (active.size) await new Promise<void>(resolve => drained.push(resolve));
  } };
}
