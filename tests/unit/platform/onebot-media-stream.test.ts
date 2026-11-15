import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertOneBotAssetId, decodeOneBotBase64, downloadOneBotFile, ONEBOT_MEDIA_CHUNK_BYTES,
  OneBotDownloadCollector, sanitizeOneBotFileName, uploadOneBotFile, withOneBotMediaDeadline,
} from '../../../src/platform/onebot-media-stream.js';
import type { OneBotTransferTransport } from '../../../src/platform/onebot-media-stream.js';

function info(size = 3) { return { type: 'stream', data_type: 'file_info', file_name: 'voice.amr', file_size: size, chunk_size: 8 }; }
function chunk(bytes = Buffer.from('abc'), index = 0) {
  const data = bytes.toString('base64');
  return { type: 'stream', data_type: 'file_chunk', index, data, size: bytes.length, base64_size: data.length };
}
function complete(bytes = 3, chunks = 1) { return { type: 'response', data_type: 'file_complete', total_bytes: bytes, total_chunks: chunks }; }
afterEach(() => vi.useRealTimers());

describe('NapCat stream media frames', () => {
  it('requires ordered bounded chunks and an exact completion receipt', () => {
    const collector = new OneBotDownloadCollector(10);
    expect(collector.accept(info())).toBe(false);
    expect(collector.accept(chunk())).toBe(false);
    expect(() => collector.result()).toThrow('qq_media_incomplete_stream');
    expect(collector.accept(complete())).toBe(true);
    expect(collector.result()).toEqual({ bytes: Buffer.from('abc'), fileName: 'voice.amr' });
  });
  it.each([
    ['duplicate', [chunk(), chunk()]], ['out of order', [chunk(Buffer.from('abc'), 1)]],
    ['wrong length', [{ ...chunk(), size: 4 }]], ['wrong encoded length', [{ ...chunk(), base64_size: 3 }]],
    ['truncated completion', [chunk(), complete(4)]], ['foreign frame', [{ type: 'error', message: 'secret' }]],
    ['second info', [info()]],
  ])('rejects %s without returning partial bytes', (_name, frames) => {
    const collector = new OneBotDownloadCollector(); collector.accept(info());
    expect(() => frames.forEach(frame => collector.accept(frame))).toThrow();
    expect(() => collector.result()).toThrow('qq_media_incomplete_stream');
  });
  it('enforces actual bytes even when original audio size differs after transcoding', () => {
    const collector = new OneBotDownloadCollector(5); collector.accept(info(1));
    collector.accept(chunk()); expect(collector.accept(complete())).toBe(true);
    const overflow = new OneBotDownloadCollector(5); overflow.accept(info(1)); overflow.accept(chunk());
    expect(() => overflow.accept(chunk(Buffer.from('abc'), 1))).toThrow('qq_media_too_large');
  });
  it.each(['YQ', 'YQ==\n', 'YR==', 'data:application/octet-stream;base64,YQ==', '!!!!', ''])('rejects malformed base64 %s', data => {
    expect(() => decodeOneBotBase64(data, 3)).toThrow('qq_media_invalid_base64');
  });
  it.each(['file:///etc/passwd', '/etc/passwd', 'C:\\private', '../private', 'https://qq.com/a', 'a/b', '.'])('refuses path-like asset IDs %s', id => {
    expect(() => assertOneBotAssetId(id)).toThrow('qq_media_invalid_asset_id');
  });
  it('keeps file basenames safe without losing Chinese names', () => {
    expect(sanitizeOneBotFileName('../../报告.txt')).toBe('报告.txt');
    expect(sanitizeOneBotFileName('..')).toBe('attachment.bin');
  });
  it('accepts canonical QQ group UUIDs and encoded opaque IDs without treating them as paths', () => {
    expect(() => assertOneBotAssetId('/01234567-89ab-cdef-0123-456789abcdef')).not.toThrow();
    expect(() => assertOneBotAssetId(Buffer.from('opaque-native-file-id').toString('base64'))).not.toThrow();
    expect(() => assertOneBotAssetId('abc/../../private')).toThrow('qq_media_invalid_asset_id');
  });
  it('uses the record conversion action and does not pass a host path input', async () => {
    const streamAction = vi.fn(async (_action, _params, options) => {
      expect(options.onFrame(info(1))).toBe(false); options.onFrame(chunk()); expect(options.onFrame(complete())).toBe(true);
    });
    const result = await downloadOneBotFile('abc.amr', 'voice', { request: vi.fn(), streamAction });
    expect(result.fileName).toBe('voice.mp3');
    expect(streamAction).toHaveBeenCalledWith('download_file_record_stream', {
      file_id: 'abc.amr', chunk_size: ONEBOT_MEDIA_CHUNK_BYTES, out_format: 'mp3',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('does not treat a transport close before completion as success', async () => {
    const streamAction = vi.fn(async (_action, _params, options) => { options.onFrame(info()); options.onFrame(chunk()); });
    await expect(downloadOneBotFile('abc', 'file', { request: vi.fn(), streamAction })).rejects.toThrow('qq_media_incomplete_stream');
  });
});

function uploadTransport(overrides: (params: Record<string, unknown>, reply: Record<string, unknown>) => unknown = (_p, reply) => reply) {
  let first: Record<string, unknown> = {};
  const request = vi.fn(async (_action: string, params: Record<string, unknown>) => {
    if (!params['is_complete']) first = params;
    const reply = params['is_complete'] ? {
      type: 'response', status: 'file_complete', stream_id: first['stream_id'],
      received_chunks: first['total_chunks'], total_chunks: first['total_chunks'], file_size: first['file_size'],
      sha256: first['expected_sha256'], file_path: `/tmp/${first['filename']}`,
    } : { type: 'stream', status: 'chunk_received', stream_id: params['stream_id'], received_chunks: Number(params['chunk_index']) + 1, total_chunks: params['total_chunks'] };
    return overrides(params, reply);
  });
  return { request, streamAction: vi.fn() } satisfies OneBotTransferTransport;
}
describe('NapCat bounded upload', () => {
  it('stages sequential bounded chunks, verifies hash, and never sends a message', async () => {
    const transport = uploadTransport(); const bytes = Buffer.alloc(ONEBOT_MEDIA_CHUNK_BYTES + 17, 3);
    const result = await uploadOneBotFile(bytes, '../报告.txt', transport);
    expect(result.fileSize).toBe(bytes.length);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.filePath).toMatch(/^\/tmp\/[a-f0-9-]+-报告\.txt$/);
    expect(transport.request).toHaveBeenCalledTimes(3);
    for (const [action, params] of transport.request.mock.calls) {
      expect(action).toBe('upload_file_stream');
      if (params['chunk_data']) expect(String(params['chunk_data']).length).toBeLessThanOrEqual(65536);
    }
  });
  it('snapshots caller bytes before an asynchronous upload', async () => {
    const bytes = Buffer.from('original');
    const transport = uploadTransport((_p, reply) => { bytes.fill(0); return reply; });
    const result = await uploadOneBotFile(bytes, 'test.txt', transport);
    expect(result.sha256).toBe(createHash('sha256').update('original').digest('hex'));
  });
  it.each(['sha256', 'file_size', 'stream_id', 'file_path'])('rejects a mismatched final %s receipt', async key => {
    const transport = uploadTransport((params, reply) => params['is_complete'] ? { ...reply, [key]: 'wrong' } : reply);
    await expect(uploadOneBotFile(Buffer.from('abc'), 'a.txt', transport)).rejects.toThrow('qq_media_upload_receipt_invalid');
  });
  it('does not finalize or retry after an invalid chunk acknowledgement', async () => {
    const transport = uploadTransport((_params, reply) => ({ ...reply, received_chunks: 0 }));
    await expect(uploadOneBotFile(Buffer.from('abc'), 'a.txt', transport)).rejects.toThrow('qq_media_upload_ack_invalid');
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it('shares one deadline and rejects cancellation before any work', async () => {
    const controller = new AbortController(); controller.abort(); const transport = uploadTransport();
    await expect(uploadOneBotFile(Buffer.from('abc'), 'a.txt', transport, { signal: controller.signal })).rejects.toThrow('qq_media_aborted');
    expect(transport.request).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const fn = vi.fn(async () => new Promise<void>(() => {}));
    const pending = withOneBotMediaDeadline({ timeoutMs: 100 }, fn);
    const assertion = expect(pending).rejects.toThrow('qq_media_aborted');
    await vi.advanceTimersByTimeAsync(101); await assertion;
    expect(fn.mock.calls[0]?.[0]?.aborted).toBe(true);
  });
});
