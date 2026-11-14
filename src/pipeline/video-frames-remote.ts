import { VIDEO_DEADLINE_MS, VIDEO_INPUT_MAX_BYTES, VIDEO_RESPONSE_MAX_BYTES, VideoComputeError,
  decodeVideoResponse, sha256 } from '../compute/video-contract.js';
import type { VideoFrame, VideoIdentity } from '../compute/video-contract.js';

export interface RemoteVideoOptions {
  endpoints: readonly string[]; token: string; identity: VideoIdentity;
  timeoutMs: number; maxDurationSec: number; signal?: AbortSignal;
}
function endpoint(base: string): URL {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) throw new VideoComputeError('video_frames_endpoint_invalid');
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new VideoComputeError('video_frames_endpoint_transport_insecure');
  }
  return new URL('/v1/video/frames', url);
}
async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new VideoComputeError('video_frames_response_empty');
  if (Number(response.headers.get('content-length')) > VIDEO_RESPONSE_MAX_BYTES) {
    await response.body.cancel(); throw new VideoComputeError('video_frames_response_limit');
  }
  let size = 0; const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > VIDEO_RESPONSE_MAX_BYTES) { await reader.cancel(); throw new VideoComputeError('video_frames_response_limit'); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}
/** Pure byte computation may be retried; all attempts share one absolute deadline. */
export async function remoteVideoFrames(bytes: Uint8Array, options: RemoteVideoOptions): Promise<VideoFrame[]> {
  if (bytes.byteLength === 0 || bytes.byteLength > VIDEO_INPUT_MAX_BYTES) throw new VideoComputeError('video_frames_input_limit');
  if (options.token.length < 32 || options.token.length > 256 || !/^[\x21-\x7e]+$/.test(options.token)) throw new VideoComputeError('video_frames_auth_invalid');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > VIDEO_DEADLINE_MS
    || !Number.isInteger(options.maxDurationSec) || options.maxDurationSec < 1 || options.maxDurationSec > 300
    || options.endpoints.length < 1 || options.endpoints.length > 4) throw new VideoComputeError('video_frames_config_invalid');
  const targets = options.endpoints.map(endpoint);
  const input = Buffer.from(bytes); // Freeze caller-owned bytes across asynchronous attempts.
  const inputSha256 = sha256(input);
  const end = Date.now() + options.timeoutMs;
  const overall = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  let code = 'video_frames_remote_unavailable';
  for (let index = 0; index < targets.length; index++) {
    if (overall.aborted) throw new VideoComputeError('video_frames_aborted');
    // Reserve time for remaining configured replicas instead of spending the
    // entire operation deadline on an unresponsive first endpoint.
    const budget = Math.max(1, Math.floor((end - Date.now()) / (targets.length - index)));
    const signal = AbortSignal.any([overall, AbortSignal.timeout(budget)]);
    try {
      const response = await fetch(targets[index]!, { method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/octet-stream',
          'x-nyat-video-protocol': options.identity.protocol, 'x-nyat-video-decoder': options.identity.decoderSha256,
          'x-nyat-video-sha256': inputSha256, 'x-nyat-video-duration': String(options.maxDurationSec),
          'x-nyat-video-timeout': String(budget) }, body: input });
      if (!response.ok) { await response.body?.cancel(); throw new VideoComputeError(`video_frames_http_${response.status}`); }
      const frames = decodeVideoResponse(await boundedResponse(response), options.identity, inputSha256, options.maxDurationSec);
      if (overall.aborted) throw new VideoComputeError('video_frames_aborted');
      return frames;
    } catch (error) {
      if (overall.aborted) throw new VideoComputeError('video_frames_aborted');
      code = error instanceof VideoComputeError ? error.code : signal.aborted ? 'video_frames_timeout' : 'video_frames_remote_unavailable';
    }
  }
  throw new VideoComputeError(code);
}
