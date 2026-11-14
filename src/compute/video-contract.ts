import { createHash } from 'node:crypto';

export const VIDEO_PROTOCOL = 'nyat-video-frames-v1';
export const VIDEO_INPUT_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_FRAME_MAX_BYTES = 2 * 1024 * 1024;
export const VIDEO_RESPONSE_MAX_BYTES = 9 * 1024 * 1024;
export const VIDEO_DEADLINE_MS = 20_000;
export interface VideoFrame { png: Buffer; atSeconds: number }
export interface VideoIdentity { protocol: typeof VIDEO_PROTOCOL; decoderSha256: string }
export class VideoComputeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VideoComputeError'; }
}
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function videoIdentity(decoderSha256: string): VideoIdentity {
  if (!validDigest(decoderSha256)) throw new VideoComputeError('video_frames_identity_invalid');
  return { protocol: VIDEO_PROTOCOL, decoderSha256 };
}
export function sameVideoIdentity(actual: unknown, expected: VideoIdentity): boolean {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const row = actual as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.protocol === expected.protocol && row.decoderSha256 === expected.decoderSha256;
}
export function validPng(bytes: Buffer): boolean {
  return bytes.length >= 33 && bytes.length <= VIDEO_FRAME_MAX_BYTES
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 640
    && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 640;
}
export function validFrames(frames: VideoFrame[], maxDuration: number): boolean {
  return frames.length > 0 && frames.length <= 3 && frames.every((frame, index) =>
    Buffer.isBuffer(frame.png) && validPng(frame.png) && Number.isFinite(frame.atSeconds)
    && frame.atSeconds >= 0 && frame.atSeconds < maxDuration
    && (index === 0 ? frame.atSeconds === 0 : frame.atSeconds > frames[index - 1]!.atSeconds));
}
export function decodeVideoResponse(payload: unknown, identity: VideoIdentity, inputSha256: string, maxDuration: number): VideoFrame[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new VideoComputeError('video_frames_response_invalid');
  const body = payload as Record<string, unknown>;
  if (Object.keys(body).length !== 3 || !sameVideoIdentity(body.identity, identity)
    || body.inputSha256 !== inputSha256 || !Array.isArray(body.frames) || body.frames.length > 3) {
    throw new VideoComputeError('video_frames_response_binding_invalid');
  }
  const frames: VideoFrame[] = body.frames.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new VideoComputeError('video_frames_response_invalid');
    const item = row as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || typeof item.png !== 'string' || item.png.length > 2_796_204
      || item.png.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.png)
      || typeof item.atSeconds !== 'number') throw new VideoComputeError('video_frames_response_invalid');
    const png = Buffer.from(item.png, 'base64');
    if (png.toString('base64') !== item.png) throw new VideoComputeError('video_frames_response_invalid');
    return { png, atSeconds: item.atSeconds };
  });
  if (!validFrames(frames, maxDuration)) throw new VideoComputeError('video_frames_output_invalid');
  return frames;
}
