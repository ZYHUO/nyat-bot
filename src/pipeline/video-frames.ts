import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { env } from '../env.js';
import { remoteVideoFrames } from './video-frames-remote.js';
import { videoIdentity } from '../compute/video-contract.js';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
const DEADLINE_MS = 20_000;
const FORMATS = 'mov,matroska,avi';
let activeExtractions = 0;

export interface VideoFrame {
  png: Buffer;
  atSeconds: number;
}

export class VideoFrameError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'VideoFrameError'; }
}

/** No user path, URL or decoder options are accepted by this boundary. */
function runBounded(binary: string, args: string[], cwd: string, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(new VideoFrameError('video_frames_aborted'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/prlimit', [
      '--as=1073741824', '--cpu=15', '--fsize=2097152', '--nofile=32', '--', binary, ...args,
    ], {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: cwd, TMPDIR: cwd },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let failure: VideoFrameError | undefined;
    let finished = false;
    const kill = (code: string): void => {
      failure ??= new VideoFrameError(code);
      child.kill('SIGKILL');
    };
    const abort = (): void => kill('video_frames_aborted');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) kill('video_frames_output_limit');
      else if (!failure) chunks.push(chunk);
    });
    // Drain without retaining decoder diagnostics, which can contain input data.
    child.stderr.on('data', () => {});
    child.on('error', () => { failure ??= new VideoFrameError('video_frames_spawn_failed'); });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new VideoFrameError('video_frames_decode_failed'));
      else resolve(Buffer.concat(chunks, total));
    });
  });
}

interface ProbeInfo {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{ width?: number; height?: number; duration?: string }>;
}

/** Decode bounded downloaded bytes using a separately installed restricted build. */
export async function extractVideoFrames(bytes: Uint8Array, callerSignal?: AbortSignal): Promise<VideoFrame[]> {
  const cfg = env();
  if (!cfg.VIDEO_FRAME_FALLBACK_ENABLED) throw new VideoFrameError('video_frames_disabled');
  if (cfg.VIDEO_REMOTE_ENABLED) {
    return remoteVideoFrames(bytes, { endpoints: cfg.VIDEO_REMOTE_ENDPOINTS, token: cfg.VIDEO_REMOTE_TOKEN,
      identity: videoIdentity(cfg.VIDEO_REMOTE_DECODER_SHA256), timeoutMs: cfg.VIDEO_REMOTE_TIMEOUT_MS,
      maxDurationSec: Math.min(300, cfg.VIDEO_MAX_DURATION_SEC), signal: callerSignal });
  }
  const binary = cfg.VIDEO_FFMPEG_PATH;
  if (!binary || !isAbsolute(binary) || !binary.endsWith('/ffmpeg')) throw new VideoFrameError('video_frames_not_configured');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) throw new VideoFrameError('video_frames_input_limit');
  if (activeExtractions >= 2) throw new VideoFrameError('video_frames_busy');
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  if (signal.aborted) throw new VideoFrameError('video_frames_aborted');
  activeExtractions++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'nyat-video-'));
    const input = join(directory, 'input.bin');
    await writeFile(input, bytes, { mode: 0o600 });
    const common = ['-hide_banner', '-v', 'error', '-max_alloc', '67108864'];
    const inputOptions = ['-protocol_whitelist', 'file', '-format_whitelist', FORMATS,
      '-probesize', '1048576', '-analyzeduration', '2000000'];
    const raw = await runBounded(join(dirname(binary), 'ffprobe'), [
      ...common, ...inputOptions, '-select_streams', 'v:0', '-show_entries',
      'format=duration,format_name:stream=width,height,duration', '-of', 'json', input,
    ], directory, signal, 16 * 1024);
    let metadata: ProbeInfo;
    try { metadata = JSON.parse(raw.toString('utf8')) as ProbeInfo; }
    catch { throw new VideoFrameError('video_frames_invalid_metadata'); }
    const stream = metadata?.streams?.[0];
    const width = stream?.width ?? 0; const height = stream?.height ?? 0;
    const duration = Number(metadata?.format?.duration ?? stream?.duration);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS
      || !Number.isFinite(duration) || duration <= 0 || duration > Math.min(300, cfg.VIDEO_MAX_DURATION_SEC)) {
      throw new VideoFrameError('video_frames_metadata_limit');
    }
    // MOV external data references remain disabled even on a broader binary.
    const formatName = metadata.format?.format_name;
    if (typeof formatName !== 'string') throw new VideoFrameError('video_frames_invalid_metadata');
    const mov = formatName.split(',').includes('mov');
    const externalReferences = mov ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : [];
    const positions = duration < 1 ? [0] : [0, 1 / 3, 2 / 3].map(fraction => duration * fraction);
    const frames: VideoFrame[] = [];
    for (const atSeconds of positions) {
      const png = await runBounded(binary, [
        '-nostdin', ...common, ...inputOptions, ...externalReferences, '-threads', '1',
        '-max_pixels', String(MAX_PIXELS), '-ss', atSeconds.toFixed(3), '-i', input,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-threads', '1',
        '-vf', 'scale=w=min(640\\,iw):h=min(640\\,ih):force_original_aspect_ratio=decrease',
        '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
      ], directory, signal, MAX_FRAME_BYTES);
      // Very low frame-rate clips can legitimately have no frame after a seek.
      if (png.length === 0 && frames.length > 0) continue;
      if (png.length < 24 || png.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0
        || png.readUInt32BE(16) > 640 || png.readUInt32BE(20) > 640
        || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) {
        throw new VideoFrameError('video_frames_invalid_output');
      }
      frames.push({ png, atSeconds });
    }
    return frames;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    activeExtractions--;
  }
}
