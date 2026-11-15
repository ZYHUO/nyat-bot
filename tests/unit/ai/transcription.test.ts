import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { config, usage, labels, lease, release, getUsageMock } = vi.hoisted(() => ({
  config: { AUDIO_TRANSCRIBE_ENABLED: true, AI_WORKLOAD_BUDGET_ENABLED: true, AI_MAX_INFLIGHT_PER_MODEL: 2, AI_MAX_BACKGROUND_INFLIGHT_PER_MODEL: 1 },
  usage: { label: 'speech', backups: [] as string[], timeout: 60_000 },
  labels: { speech: { name: 'speech', endpoint: 'https://provider.example/v1', model: 'whisper-large-v3-turbo', apiKeys: ['test-secret'], apiFormat: 'openai' } } as Record<string, { name: string; endpoint: string; model: string; apiKeys: string[]; apiFormat: string }>,
  lease: vi.fn(), release: vi.fn(), getUsageMock: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/ai/labels.js', () => ({ getUsage: getUsageMock, getLabel: (name: string) => labels[name] }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/ai/workload.js', () => ({ acquireAiLease: lease, getAiWorkload: () => 'interactive' }));
import { audioUploadMetadata, MAX_AUDIO_BYTES, transcribeAudio, transcriptionEndpoint } from '../../../src/ai/transcription.js';

const fetchMock = vi.fn();
const input = () => ({ buffer: new TextEncoder().encode('audio-bytes').buffer, mimeType: 'application/octet-stream', fileName: 'voice/file_1.oga' });
beforeEach(() => {
  vi.clearAllMocks(); config.AUDIO_TRANSCRIBE_ENABLED = true; config.AI_WORKLOAD_BUDGET_ENABLED = true;
  usage.backups = []; usage.timeout = 60_000;
  labels.speech!.endpoint = 'https://provider.example/v1';
  lease.mockResolvedValue({ release }); release.mockResolvedValue(undefined); getUsageMock.mockReturnValue(usage);
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('audio transcription endpoint and multipart transport', () => {
  it.each([
    ['https://provider.example', 'https://provider.example/v1/audio/transcriptions'],
    ['https://provider.example/v1/', 'https://provider.example/v1/audio/transcriptions'],
    ['https://provider.example/proxy/v1/chat/completions', 'https://provider.example/proxy/v1/audio/transcriptions'],
    ['https://provider.example/v1/audio/transcriptions', 'https://provider.example/v1/audio/transcriptions'],
  ])('keeps the configured origin when normalizing %s', (base, expected) => expect(transcriptionEndpoint(base)).toBe(expected));
  it.each(['http://provider.example/v1', 'https://user:secret@provider.example/v1', 'https://provider.example/v1?api_key=secret'])('rejects unsafe endpoint configuration: %s', (base) => {
    expect(() => transcriptionEndpoint(base)).toThrow();
  });
  it('uses the audio label/model/key with real MIME/filename and no chat token parameters', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: '今天在上海测试语音。' })));
    expect(await transcribeAudio(input())).toEqual({ status: 'ok', text: '今天在上海测试语音。', label: 'speech' });
    expect(getUsageMock).toHaveBeenCalledWith('audio');
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/audio/transcriptions');
    expect(options.redirect).toBe('manual');
    expect(options.headers).toEqual({ Authorization: 'Bearer test-secret' });
    const body = options.body as FormData;
    expect(body.get('model')).toBe('whisper-large-v3-turbo');
    expect(body.get('response_format')).toBe('json');
    const file = body.get('file') as File;
    expect(file.name).toBe('file_1.oga'); expect(file.type).toBe('audio/ogg'); expect(file.size).toBe(11);
    expect(body.has('max_tokens')).toBe(false); expect(body.has('messages')).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(lease).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ model: 'whisper-large-v3-turbo', timeoutMs: 30_000, workload: 'interactive' }));
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('derives upload metadata from a trusted MIME when the filename has no extension', () => {
    expect(audioUploadMetadata('music/file_2', 'audio/mpeg; charset=binary')).toEqual({ fileName: 'file_2.mp3', mimeType: 'audio/mpeg' });
    expect(audioUploadMetadata('x.unknown', 'application/octet-stream')).toBeNull();
  });
  it('does not look up a model, lease or network when disabled or oversized', async () => {
    config.AUDIO_TRANSCRIBE_ENABLED = false;
    expect(await transcribeAudio(input())).toEqual({ status: 'skipped', reason: 'disabled' });
    config.AUDIO_TRANSCRIBE_ENABLED = true;
    expect(await transcribeAudio({ ...input(), buffer: new ArrayBuffer(MAX_AUDIO_BYTES + 1) })).toEqual({ status: 'skipped', reason: 'too_large' });
    expect(getUsageMock).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [new Response('private provider details test-secret', { status: 500 }), 'http_error', 'failed'],
    [new Response('', { status: 302, headers: { Location: 'https://untrusted.example/collect' } }), 'redirect', 'failed'],
    [new Response(JSON.stringify({ text: '   ' })), 'empty', 'empty'],
    [new Response(JSON.stringify({ content: 'wrong format' })), 'invalid_response', 'failed'],
  ])('keeps a distinct bounded failure/empty outcome and releases the lease', async (response, reason, status) => {
    fetchMock.mockResolvedValue(response);
    const result = await transcribeAudio(input());
    expect(result).toEqual({ status, reason });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  });
  it('releases the lease on provider timeout without falling back to chat input_audio', async () => {
    fetchMock.mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    expect(await transcribeAudio(input())).toEqual({ status: 'failed', reason: 'timeout' });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not upload when the workload budget is full', async () => {
    lease.mockResolvedValue(null);
    expect(await transcribeAudio(input())).toEqual({ status: 'failed', reason: 'busy' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  });
  it('honors caller cancellation before acquiring a lease or uploading', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await transcribeAudio({ ...input(), signal: controller.signal })).toEqual({ status: 'failed', reason: 'aborted' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled();
  });
});
