import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVideoServer } from '../../../src/compute/video-server.js';
import { remoteVideoFrames } from '../../../src/pipeline/video-frames-remote.js';
import { videoIdentity, sha256, VIDEO_INPUT_MAX_BYTES, VIDEO_RESPONSE_MAX_BYTES } from '../../../src/compute/video-contract.js';
import type { VideoFrame } from '../../../src/compute/video-contract.js';
import { videoComputeEnv } from '../../../src/compute/video-env.js';

const TOKEN = 'synthetic-video-token-with-32-characters';
const identity = videoIdentity('a'.repeat(64));
const bytes = Buffer.from('synthetic-video-input');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=', 'base64');
const frames = (): VideoFrame[] => [{ png, atSeconds: 0 }, { png, atSeconds: 1 }, { png, atSeconds: 2 }];
const servers: Server[] = [];
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream',
  'x-nyat-video-protocol': identity.protocol, 'x-nyat-video-decoder': identity.decoderSha256,
  'x-nyat-video-sha256': sha256(bytes), 'x-nyat-video-duration': '300', 'x-nyat-video-timeout': '20000' };
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const options = (endpoints: string[], signal?: AbortSignal) => ({ endpoints, token: TOKEN, identity, timeoutMs: 2000, maxDurationSec: 300, signal });
const post = (url: string, more = {}, body: Uint8Array = bytes) => fetch(url + '/v1/video/frames', { method: 'POST', headers: { ...headers, ...more }, body });
const health = async (url: string) => (await fetch(url + '/health', { headers })).json();
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe('video compute real HTTP contract and replica failover', () => {
  it('transfers exact bytes, binds response to the pinned decoder and input, and fails over across two actual servers', async () => {
    const seen: string[] = [];
    const first = await listen(createServer((_req, res) => { seen.push('first'); res.writeHead(503); res.end(); }));
    const decode = vi.fn(async (input: Uint8Array, maxDuration: number, signal: AbortSignal) => {
      seen.push('second'); expect(Buffer.from(input)).toEqual(bytes); expect(maxDuration).toBe(300); expect(signal.aborted).toBe(false); return frames();
    });
    const second = await listen(createVideoServer({ token: TOKEN, identity, decode }).server);
    expect(await remoteVideoFrames(bytes, options([first, second]))).toEqual(frames());
    expect(seen).toEqual(['first', 'second']); expect(decode).toHaveBeenCalledOnce();
    expect(await health(second)).toMatchObject({ status: 'ready', identity, inflight: 0 });
  });
  it('rejects auth, URLs/paths, JSON, wrong decoder and forged input hashes before decoding', async () => {
    const decode = vi.fn(async () => frames());
    const url = await listen(createVideoServer({ token: TOKEN, identity, decode }).server);
    expect((await fetch(url + '/health')).status).toBe(401);
    expect((await post(url, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await fetch(url + '/v1/video/frames?path=/etc/passwd', { method: 'POST', headers, body: bytes })).status).toBe(404);
    expect((await post(url, { 'content-type': 'application/json' }, Buffer.from('{"url":"http://private/"}'))).status).toBe(415);
    expect((await post(url, { 'x-nyat-video-decoder': 'b'.repeat(64) })).status).toBe(409);
    expect((await post(url, { 'x-nyat-video-sha256': 'c'.repeat(64) })).status).toBe(400);
    expect(decode).not.toHaveBeenCalled();
  });
  it('bounds declared and chunked bytes before native work and never logs input in errors', async () => {
    const decode = vi.fn(async () => { throw Error('PRIVATE_CANARY'); });
    const url = await listen(createVideoServer({ token: TOKEN, identity, decode }).server);
    const huge = await post(url, {}, Buffer.alloc(VIDEO_INPUT_MAX_BYTES + 1));
    expect(huge.status).toBe(413); expect(decode).not.toHaveBeenCalled();
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request(url + '/v1/video/frames', { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.write(Buffer.alloc(VIDEO_INPUT_MAX_BYTES)); req.end(Buffer.from('x'));
    });
    expect(chunked).toBe(413); expect(decode).not.toHaveBeenCalled();
    const failure = await post(url); expect(failure.status).toBe(503);
    expect(await failure.text()).toBe('{"error":"compute_failed"}');
  });
  it('reserves capacity while reading slow uploads, not only after buffering them', async () => {
    const decode = vi.fn(async () => frames());
    const url = await listen(createVideoServer({ token: TOKEN, identity, decode }).server);
    const slow = request(url + '/v1/video/frames', { method: 'POST', headers });
    slow.on('error', () => {}); slow.write(bytes.subarray(0, 2));
    await vi.waitFor(async () => expect(await health(url)).toMatchObject({ inflight: 1 }));
    expect((await post(url)).status).toBe(429); expect(decode).not.toHaveBeenCalled();
    slow.destroy();
    await vi.waitFor(async () => expect(await health(url)).toMatchObject({ inflight: 0 }));
  });
  it('aborts on timeout but holds capacity until the actual decoder settles', async () => {
    let release!: (value: VideoFrame[]) => void; let aborted = false;
    const decode = vi.fn((_input, _duration, signal: AbortSignal) => new Promise<VideoFrame[]>(resolve => {
      release = resolve; signal.addEventListener('abort', () => { aborted = true; });
    }));
    const url = await listen(createVideoServer({ token: TOKEN, identity, decode, timeoutMs: 100 }).server);
    expect((await post(url)).status).toBe(504); expect(aborted).toBe(true);
    expect((await post(url)).status).toBe(429); expect(await health(url)).toMatchObject({ inflight: 1 });
    release(frames());
    await vi.waitFor(async () => expect(await health(url)).toMatchObject({ inflight: 0 }));
  });
  it('disconnect cancels native work, and shutdown joins its actual settlement', async () => {
    let release!: (value: VideoFrame[]) => void; let aborted = false;
    const runtime = createVideoServer({ token: TOKEN, identity, decode: (_input, _duration, signal) => new Promise(resolve => {
      release = resolve; signal.addEventListener('abort', () => { aborted = true; });
    }) });
    const url = await listen(runtime.server), abort = new AbortController();
    const pending = remoteVideoFrames(bytes, options([url], abort.signal));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'video_frames_aborted' });
    await vi.waitFor(async () => expect(await health(url)).toMatchObject({ inflight: 1 }));
    abort.abort(); await rejected;
    await vi.waitFor(() => expect(aborted).toBe(true));
    let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(stopped).toBe(false);
    release(frames()); await stop; expect(stopped).toBe(true);
  });
  it('does not retry after caller cancellation or follow redirects with the credential', async () => {
    const touched = vi.fn();
    const target = await listen(createServer((_req, res) => { touched(); res.end('{}'); }));
    const redirect = await listen(createServer((_req, res) => { res.writeHead(307, { location: target + '/v1/video/frames' }); res.end(); }));
    await expect(remoteVideoFrames(bytes, options([redirect]))).rejects.toThrow();
    const cancelled = AbortSignal.abort();
    await expect(remoteVideoFrames(bytes, options([target], cancelled))).rejects.toMatchObject({ code: 'video_frames_aborted' });
    expect(touched).not.toHaveBeenCalled();
  });
  it('bounds all replicas by one deadline and reserves a chance for the healthy second replica', async () => {
    let release!: (value: VideoFrame[]) => void;
    const slow = await listen(createVideoServer({ token: TOKEN, identity, decode: () => new Promise(resolve => { release = resolve; }) }).server);
    const good = await listen(createVideoServer({ token: TOKEN, identity, decode: async () => frames() }).server);
    const start = Date.now();
    expect(await remoteVideoFrames(bytes, { ...options([slow, good]), timeoutMs: 600 })).toEqual(frames());
    expect(Date.now() - start).toBeLessThan(1000); release(frames());
  });
  it('rejects wrong input bindings, malformed PNGs and oversized responses', async () => {
    const response = (change: object) => ({ identity, inputSha256: sha256(bytes),
      frames: frames().map(frame => ({ png: frame.png.toString('base64'), atSeconds: frame.atSeconds })), ...change });
    for (const body of [response({ inputSha256: 'b'.repeat(64) }), response({ identity: videoIdentity('b'.repeat(64)) }),
      response({ frames: [{ png: Buffer.from('not PNG').toString('base64'), atSeconds: 0 }] })]) {
      const url = await listen(createServer((_req, res) => { res.end(JSON.stringify(body)); }));
      await expect(remoteVideoFrames(bytes, options([url]))).rejects.toThrow();
    }
    const huge = await listen(createServer((_req, res) => { res.writeHead(200, { 'content-length': String(VIDEO_RESPONSE_MAX_BYTES + 1) }); res.end('x'); }));
    await expect(remoteVideoFrames(bytes, options([huge]))).rejects.toMatchObject({ code: 'video_frames_response_limit' });
  });
  it('freezes caller bytes and refuses unsafe endpoint/config forms', async () => {
    let actual: Uint8Array | undefined;
    const url = await listen(createVideoServer({ token: TOKEN, identity, decode: async input => { actual = input; return frames(); } }).server);
    const mutable = Buffer.from(bytes), pending = remoteVideoFrames(mutable, options([url])); mutable.fill(0);
    await pending; expect(actual).toEqual(bytes);
    await expect(remoteVideoFrames(bytes, options(['http://user:pass@localhost/']))).rejects.toMatchObject({ code: 'video_frames_endpoint_invalid' });
    await expect(remoteVideoFrames(bytes, options(['http://192.0.2.2/']))).rejects.toMatchObject({ code: 'video_frames_endpoint_transport_insecure' });
    await expect(remoteVideoFrames(Buffer.alloc(0), options([url]))).rejects.toMatchObject({ code: 'video_frames_input_limit' });
    expect(() => videoComputeEnv({ VIDEO_COMPUTE_TOKEN: TOKEN, VIDEO_COMPUTE_PROFILE: '/fixed/profile.json',
      VIDEO_COMPUTE_DECODER_SHA256: identity.decoderSha256, VIDEO_COMPUTE_HOST: '0.0.0.0' })).toThrow('configuration_invalid');
    expect(videoComputeEnv({ VIDEO_COMPUTE_TOKEN: TOKEN, VIDEO_COMPUTE_PROFILE: '/fixed/profile.json',
      VIDEO_COMPUTE_DECODER_SHA256: identity.decoderSha256 })).toMatchObject({ host: '127.0.0.1', port: 3033, maxConcurrent: 1 });
  });
});
