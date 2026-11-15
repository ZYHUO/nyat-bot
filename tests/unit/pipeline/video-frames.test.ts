import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cfg, remote, spawnMock, mkdirMock, writeMock, removeMock } = vi.hoisted(() => ({
  cfg: { VIDEO_FRAME_FALLBACK_ENABLED: true, VIDEO_FFMPEG_PATH: '/restricted/bin/ffmpeg', VIDEO_MAX_DURATION_SEC: 300,
    VIDEO_REMOTE_ENABLED: false, VIDEO_REMOTE_ENDPOINTS: ['http://127.0.0.1:3042', 'http://127.0.0.1:3041'],
    VIDEO_REMOTE_TOKEN: 'synthetic-remote-video-token-with-32chars', VIDEO_REMOTE_DECODER_SHA256: 'a'.repeat(64), VIDEO_REMOTE_TIMEOUT_MS: 20000 },
  remote: vi.fn(),
  spawnMock: vi.fn(), mkdirMock: vi.fn(), writeMock: vi.fn(), removeMock: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => cfg }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs/promises', () => ({ mkdtemp: mkdirMock, writeFile: writeMock, rm: removeMock }));
vi.mock('../../../src/pipeline/video-frames-remote.js', () => ({ remoteVideoFrames: remote }));
import { extractVideoFrames } from '../../../src/pipeline/video-frames.js';

const png = (): Buffer => {
  const value = Buffer.alloc(32); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
  value.writeUInt32BE(640, 16); value.writeUInt32BE(360, 20); return value;
};
const metadata = (change: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({
  format: { duration: '9', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  streams: [{ width: 1920, height: 1080 }], ...change,
}));
function processChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
  });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true; });
  return child;
}
const output = (bytes: Buffer) => () => {
  const child = processChild();
  queueMicrotask(() => { child.stdout.emit('data', bytes); child.emit('close', 0); });
  return child;
};
beforeEach(() => {
  vi.clearAllMocks(); cfg.VIDEO_FRAME_FALLBACK_ENABLED = true; cfg.VIDEO_FFMPEG_PATH = '/restricted/bin/ffmpeg'; cfg.VIDEO_MAX_DURATION_SEC = 300;
  cfg.VIDEO_REMOTE_ENABLED = false; remote.mockReset();
  mkdirMock.mockResolvedValue('/private/video-test'); writeMock.mockResolvedValue(undefined); removeMock.mockResolvedValue(undefined);
  spawnMock.mockImplementation((_binary: string, args: string[]) => output(args.includes('-of') ? metadata() : png())());
});

describe('bounded video frame extraction', () => {
  it('routes the actual enabled entry to isolated replicas and never falls back to the legacy subprocess', async () => {
    cfg.VIDEO_REMOTE_ENABLED = true;
    const bytes = Buffer.from('synthetic input'), signal = new AbortController().signal;
    const frames = [{ png: png(), atSeconds: 0 }]; remote.mockResolvedValueOnce(frames);
    expect(await extractVideoFrames(bytes, signal)).toEqual(frames);
    expect(remote).toHaveBeenCalledWith(bytes, expect.objectContaining({ endpoints: cfg.VIDEO_REMOTE_ENDPOINTS,
      identity: { protocol: 'nyat-video-frames-v1', decoderSha256: cfg.VIDEO_REMOTE_DECODER_SHA256 }, signal }));
    remote.mockRejectedValueOnce(new Error('both replicas unavailable'));
    await expect(extractVideoFrames(bytes)).rejects.toThrow('both replicas unavailable');
    expect(spawnMock).not.toHaveBeenCalled(); expect(writeMock).not.toHaveBeenCalled();
  });
  it('uses private bounded bytes, exact resource limits and only sampled PNG output', async () => {
    const input = Buffer.from('already-downloaded-video');
    const result = await extractVideoFrames(input);
    expect(result.map(frame => frame.atSeconds)).toEqual([0, 3, 6]);
    expect(result.every(frame => frame.png.equals(png()))).toBe(true);
    expect(writeMock).toHaveBeenCalledWith(join('/private/video-test', 'input.bin'), input, { mode: 0o600 });
    expect(spawnMock).toHaveBeenCalledTimes(4);
    for (const [binary, args, options] of spawnMock.mock.calls) {
      expect(binary).toBe('/usr/bin/prlimit');
      expect(args).toEqual(expect.arrayContaining(['--as=1073741824', '--cpu=15', '--nofile=32', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,avi']));
      expect(options.shell).toBe(false);
      expect(Object.keys(options.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
      expect(options.cwd).toBe('/private/video-test');
    }
    for (const [, args] of spawnMock.mock.calls.slice(1)) {
      expect(args).toEqual(expect.arrayContaining(['-enable_drefs', '0', '-use_absolute_path', '0', '-max_pixels', '16777216', '-frames:v', '1', '-c:v', 'png', 'pipe:1']));
      expect(args[args.indexOf('-vf') + 1]).toContain('min(640');
    }
    expect(removeMock).toHaveBeenCalledWith('/private/video-test', { recursive: true, force: true });
  });
  it('does not allocate files or subprocesses when disabled, unconfigured or oversized', async () => {
    cfg.VIDEO_FRAME_FALLBACK_ENABLED = false;
    await expect(extractVideoFrames(Buffer.from('x'))).rejects.toMatchObject({ code: 'video_frames_disabled' });
    cfg.VIDEO_FRAME_FALLBACK_ENABLED = true; cfg.VIDEO_FFMPEG_PATH = 'ffmpeg';
    await expect(extractVideoFrames(Buffer.from('x'))).rejects.toMatchObject({ code: 'video_frames_not_configured' });
    cfg.VIDEO_FFMPEG_PATH = '/restricted/bin/ffmpeg';
    await expect(extractVideoFrames(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'video_frames_input_limit' });
    await expect(extractVideoFrames(Buffer.alloc(0))).rejects.toMatchObject({ code: 'video_frames_input_limit' });
    expect(mkdirMock).not.toHaveBeenCalled(); expect(spawnMock).not.toHaveBeenCalled();
  });
  it.each([
    { format: { duration: '301', format_name: 'avi' } },
    { format: { duration: 'Infinity', format_name: 'avi' } },
    { format: { duration: '0', format_name: 'avi' } },
    { streams: [{ width: 100000, height: 100000 }] },
    { streams: [] },
  ])('rejects metadata before any frame decoder starts: %j', async (change) => {
    spawnMock.mockImplementationOnce(output(metadata(change)));
    await expect(extractVideoFrames(Buffer.from('input'))).rejects.toMatchObject({ code: 'video_frames_metadata_limit' });
    expect(spawnMock).toHaveBeenCalledTimes(1); expect(removeMock).toHaveBeenCalledTimes(1);
  });
  it('allows a very short clip and does not add MOV options to AVI', async () => {
    spawnMock.mockImplementationOnce(output(metadata({ format: { duration: '0.5', format_name: 'avi' } })));
    const result = await extractVideoFrames(Buffer.from('input'));
    expect(result).toHaveLength(1);
    expect(spawnMock.mock.calls[1]![1]).not.toContain('-enable_drefs');
  });
  it('keeps a first frame when a low-frame-rate clip has no later seek frames', async () => {
    spawnMock.mockImplementationOnce(output(metadata())).mockImplementationOnce(output(png()))
      .mockImplementationOnce(output(Buffer.alloc(0))).mockImplementationOnce(output(Buffer.alloc(0)));
    expect(await extractVideoFrames(Buffer.from('input'))).toHaveLength(1);
  });
  it('rejects invalid PNG or huge dimensions and cleans up', async () => {
    const malformed = png(); malformed.writeUInt32BE(641, 16);
    spawnMock.mockImplementationOnce(output(metadata())).mockImplementationOnce(output(malformed));
    await expect(extractVideoFrames(Buffer.from('input'))).rejects.toMatchObject({ code: 'video_frames_invalid_output' });
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
  it('kills an output flood and does not retain unbounded bytes', async () => {
    const child = processChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(16385))); return child;
    });
    await expect(extractVideoFrames(Buffer.from('input'))).rejects.toMatchObject({ code: 'video_frames_output_limit' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(removeMock).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed metadata JSON and process errors without including stderr', async () => {
    spawnMock.mockImplementationOnce(output(Buffer.from('not json')));
    await expect(extractVideoFrames(Buffer.from('input'))).rejects.toMatchObject({ code: 'video_frames_invalid_metadata' });
    spawnMock.mockImplementationOnce(() => {
      const child = processChild(); queueMicrotask(() => { child.stderr.emit('data', Buffer.from('PRIVATE')); child.emit('error', new Error('SECRET')); child.emit('close', null); }); return child;
    });
    await expect(extractVideoFrames(Buffer.from('input'))).rejects.toThrow('video_frames_spawn_failed');
  });
  it('cancels an in-progress decoder, waits for close, and does not start frame decoding', async () => {
    const controller = new AbortController(); const child = processChild(); spawnMock.mockReturnValueOnce(child);
    const pending = extractVideoFrames(Buffer.from('input'), controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'video_frames_aborted' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1)); controller.abort();
    await assertion; expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(removeMock).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent decoders and releases slots after cancellation', async () => {
    const controller = new AbortController(); spawnMock.mockImplementation(() => processChild());
    const one = expect(extractVideoFrames(Buffer.from('a'), controller.signal)).rejects.toMatchObject({ code: 'video_frames_aborted' });
    const two = expect(extractVideoFrames(Buffer.from('b'), controller.signal)).rejects.toMatchObject({ code: 'video_frames_aborted' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    await expect(extractVideoFrames(Buffer.from('c'))).rejects.toMatchObject({ code: 'video_frames_busy' });
    controller.abort(); await Promise.all([one, two]);
    spawnMock.mockImplementation((_binary: string, args: string[]) => output(args.includes('-of') ? metadata() : png())());
    expect(await extractVideoFrames(Buffer.from('d'))).toHaveLength(3);
  });
});
