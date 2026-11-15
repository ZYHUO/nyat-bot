import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { config, spawnMock, mkdirMock, readMock, rmMock } = vi.hoisted(() => ({
  config: { TTS_ENABLED: true, TTS_VOICE: 'zh-CN-XiaoxiaoNeural', TTS_PYTHON_PATH: '/private/python3.12', TTS_FFMPEG_PATH: '/private/ffmpeg' },
  spawnMock: vi.fn(), mkdirMock: vi.fn(), readMock: vi.fn(), rmMock: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs/promises', () => ({ mkdtemp: mkdirMock, readFile: readMock, rm: rmMock }));
import { maybeSynthesizeVoice, synthesizeVoice } from '../../../src/ai/tts.js';

function child() {
  const process = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(() => true) });
  return process;
}
function validOgg(): Buffer {
  const buffer = Buffer.alloc(64); buffer.write('OggS'); buffer.write('OpusHead', 28); return buffer;
}
beforeEach(() => {
  vi.clearAllMocks(); config.TTS_ENABLED = true;
  mkdirMock.mockResolvedValue('/temporary/nyat-tts-test'); readMock.mockResolvedValue(validOgg()); rmMock.mockResolvedValue(undefined);
  spawnMock.mockImplementation(() => { const process = child(); queueMicrotask(() => process.emit('close', 0)); return process; });
});
afterEach(() => vi.useRealTimers());

describe('TTS private runtime and OGG/Opus validation', () => {
  it('blocks credentials before synthesis or temporary file creation', async () => {
    await expect(synthesizeVoice(`sk-${'synthetic_privacy_canary_'.repeat(2)}`)).rejects.toThrow('outbound_privacy_blocked');
    expect(spawnMock).not.toHaveBeenCalled(); expect(mkdirMock).not.toHaveBeenCalled();
  });
  it('passes text as a literal argv value without a shell, and enforces 48kHz mono Opus', async () => {
    const text = '你好; $(echo unsafe) `touch file`';
    expect(await synthesizeVoice(text)).toEqual(validOgg());
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [python, pythonArgs, options] = spawnMock.mock.calls[0]!;
    expect(python).toBe('/private/python3.12');
    expect(pythonArgs).toEqual(expect.arrayContaining(['-m', 'edge_tts', '--voice', 'zh-CN-XiaoxiaoNeural', '--text', text]));
    expect(options).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const [ffmpeg, ffmpegArgs] = spawnMock.mock.calls[1]!;
    expect(ffmpeg).toBe('/private/ffmpeg');
    const args = ffmpegArgs as string[];
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args[args.indexOf('-c:a') + 1]).toBe('libopus');
    expect(args[args.indexOf('-f') + 1]).toBe('ogg');
    expect(rmMock).toHaveBeenCalledWith('/temporary/nyat-tts-test', { recursive: true, force: true });
  });
  it('does not create files or subprocesses when disabled or empty', async () => {
    config.TTS_ENABLED = false; expect(await synthesizeVoice('hello')).toBeNull();
    config.TTS_ENABLED = true; expect(await synthesizeVoice('  ')).toBeNull();
    expect(mkdirMock).not.toHaveBeenCalled(); expect(spawnMock).not.toHaveBeenCalled();
  });
  it.each([Buffer.alloc(0), Buffer.from('mp3 audio data'), Buffer.from('OggS fake vorbis container with no Opus header'.padEnd(64))])('rejects invalid output and cleans up', async (buffer) => {
    readMock.mockResolvedValue(buffer);
    await expect(synthesizeVoice('hello')).rejects.toThrow('not an OGG/Opus');
    expect(rmMock).toHaveBeenCalledTimes(1);
  });
  it('keeps only bounded stderr diagnostics and cleans up a failed synthesis', async () => {
    spawnMock.mockImplementationOnce(() => {
      const process = child();
      queueMicrotask(() => { process.stderr.emit('data', Buffer.from('early-marker' + 'x'.repeat(100_000) + 'END-MARKER')); process.emit('close', 1); });
      return process;
    });
    let message = '';
    try { await synthesizeVoice('hello'); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('END-MARKER'); expect(message).not.toContain('early-marker'); expect(message.length).toBeLessThan(1000);
    expect(spawnMock).toHaveBeenCalledTimes(1); expect(rmMock).toHaveBeenCalledTimes(1);
  });
  it('handles spawn failure with cleanup and permits the non-throwing text fallback', async () => {
    spawnMock.mockImplementationOnce(() => {
      const process = child(); queueMicrotask(() => process.emit('error', new Error('ENOENT'))); return process;
    });
    expect(await maybeSynthesizeVoice('hello')).toBeNull();
    expect(rmMock).toHaveBeenCalledTimes(1);
  });
  it('kills a timed-out child, waits for close and removes its temporary files', async () => {
    vi.useFakeTimers();
    const process = child();
    process.kill.mockImplementation(() => { queueMicrotask(() => process.emit('close', null)); return true; });
    spawnMock.mockReturnValueOnce(process);
    const result = synthesizeVoice('hello');
    const assertion = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(process.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).toHaveBeenCalledTimes(1); expect(rmMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('still settles and attempts cleanup if a killed child never emits close', async () => {
    vi.useFakeTimers(); const process = child(); spawnMock.mockReturnValueOnce(process);
    const assertion = expect(synthesizeVoice('hello')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(16_000); await assertion;
    expect(rmMock).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves valid output if cleanup itself fails', async () => {
    rmMock.mockRejectedValueOnce(new Error('temporary cleanup failure'));
    expect(await synthesizeVoice('hello')).toEqual(validOgg());
  });
});
