import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ spawn: vi.fn(), mkdir: vi.fn(), write: vi.fn(), rm: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: f.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  mkdtemp: f.mkdir, writeFile: f.write, rm: f.rm }));
import { decodeVideoFrames, preflightVideoSandbox } from '../../../src/compute/video-decoder.js';
import { videoLaunchArgs } from '../../../src/compute/video-profile.js';
import type { VideoSandboxProfile } from '../../../src/compute/video-profile.js';
const pin = (path: string) => ({ path, sha256: 'a'.repeat(64) });
const profile: VideoSandboxProfile = { bwrap: pin('/fixed/bwrap'), prlimit: pin('/fixed/prlimit'),
  ffmpeg: pin('/fixed/ffmpeg'), ffprobe: pin('/fixed/ffprobe'),
  runtimeFiles: [{ ...pin('/fixed/libc.so.6'), mountPath: '/lib64/libc.so.6' }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9sAAAAASUVORK5CYII=', 'base64');
const metadata = Buffer.from(JSON.stringify({ format: { duration: '3', format_name: 'mov,mp4' }, streams: [{ width: 100, height: 100 }] }));
function child() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true) });
}
function output(bytes: Buffer) {
  const proc = child(); queueMicrotask(() => { proc.stdout.emit('data', bytes); proc.emit('close', 0); }); return proc;
}
beforeEach(() => {
  vi.clearAllMocks(); f.mkdir.mockResolvedValue('/private/video'); f.write.mockResolvedValue(undefined); f.rm.mockResolvedValue(undefined);
  f.spawn.mockImplementation((_binary, args: string[]) => output(args.includes('-of') ? metadata : png));
});
describe('standalone decoder isolation and cancellation', () => {
  it('mounts only exact pinned ELF files and one read-only input; no host directories or credential environment', async () => {
    expect(await decodeVideoFrames(Buffer.from('synthetic'), profile, 300)).toHaveLength(3);
    expect(f.write).toHaveBeenCalledWith(join('/private/video', 'input.bin'), Buffer.from('synthetic'), { mode: 0o600 });
    for (const [binary, args, options] of f.spawn.mock.calls) {
      expect(binary).toBe('/fixed/prlimit');
      expect(args).toEqual(expect.arrayContaining(['--unshare-user', '--unshare-net', '--unshare-pid', '--clearenv', '--cap-drop',
        '--fsize=0:0', '--core=0:0', '--as=1073741824:1073741824', '--remount-ro']));
      const mounts = args.flatMap((arg: string, index: number) => arg === '--ro-bind' ? [[args[index + 1], args[index + 2]]] : []);
      expect(mounts).toEqual([['/fixed/ffmpeg', '/fixed/ffmpeg'], ['/fixed/ffprobe', '/fixed/ffprobe'],
        ['/fixed/libc.so.6', '/lib64/libc.so.6'], [join('/private/video', 'input.bin'), '/input.bin']]);
      expect(args).toContain('/input.bin'); expect(args).not.toContain('--bind');
      expect(options.shell).toBe(false); expect(options.detached).toBe(true);
      expect(Object.keys(options.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
    }
    expect(f.rm).toHaveBeenCalledWith('/private/video', { recursive: true, force: true });
  });
  it('denies arbitrary executable selection and invalid duration without spawning', async () => {
    expect(() => videoLaunchArgs(profile, '/bin/sh', ['-c', 'anything'], '/input')).toThrow('executable_denied');
    await expect(decodeVideoFrames(Buffer.from('x'), profile, Number.NaN)).rejects.toMatchObject({ code: 'video_frames_duration_invalid' });
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('preflight actually launches the sandbox and rejects a failed namespace without claiming readiness', async () => {
    f.spawn.mockImplementationOnce(() => { const proc = child(); queueMicrotask(() => proc.emit('close', 1)); return proc; });
    await expect(preflightVideoSandbox(profile)).rejects.toMatchObject({ code: 'video_frames_decode_failed' });
    expect(f.spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['/fixed/ffprobe', '-version']));
    expect(f.rm).toHaveBeenCalledOnce();
  });
  it('keeps both slots during cancellation until close, then cleans temporary bytes and admits new work', async () => {
    const procs = [child(), child()]; f.spawn.mockImplementationOnce(() => procs[0]).mockImplementationOnce(() => procs[1]);
    const abort = new AbortController();
    const one = expect(decodeVideoFrames(Buffer.from('1'), profile, 300, abort.signal)).rejects.toMatchObject({ code: 'video_frames_aborted' });
    const two = expect(decodeVideoFrames(Buffer.from('2'), profile, 300, abort.signal)).rejects.toMatchObject({ code: 'video_frames_aborted' });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2)); abort.abort();
    expect(procs[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(decodeVideoFrames(Buffer.from('3'), profile, 300)).rejects.toMatchObject({ code: 'video_frames_busy' });
    expect(f.rm).not.toHaveBeenCalled();
    for (const proc of procs) proc.emit('close', null);
    await Promise.all([one, two]); expect(f.rm).toHaveBeenCalledTimes(2);
    expect(await decodeVideoFrames(Buffer.from('4'), profile, 300)).toHaveLength(3);
  });
  it('rejects decoder bombs and invalid dimensions, never returns diagnostics or launches another frame', async () => {
    f.spawn.mockImplementationOnce(() => output(Buffer.from(JSON.stringify({ format: { duration: '3', format_name: 'mov' }, streams: [{ width: 100000, height: 100000 }] }))));
    await expect(decodeVideoFrames(Buffer.from('x'), profile, 300)).rejects.toMatchObject({ code: 'video_frames_metadata_limit' });
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.rm).toHaveBeenCalledOnce();
  });
});
