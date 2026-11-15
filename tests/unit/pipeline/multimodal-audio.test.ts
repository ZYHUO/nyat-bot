import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
const { config, getFile, chat, release } = vi.hoisted(() => ({
  config: { AUDIO_TRANSCRIBE_ENABLED: true, AUDIO_TRANSCRIBE_API_MODE: 'transcriptions', AI_WORKLOAD_BUDGET_ENABLED: true, AI_MAX_INFLIGHT_PER_MODEL: 2, AI_MAX_BACKGROUND_INFLIGHT_PER_MODEL: 1 },
  getFile: vi.fn(), chat: vi.fn(), release: vi.fn(async () => {}),
}));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({ token: 'test-telegram-token', api: { getFile } }) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: chat }));
vi.mock('../../../src/ai/labels.js', () => ({ getUsage: () => ({ label: 'speech', backups: [], timeout: 30_000 }),
  getLabel: () => ({ name: 'speech', endpoint: 'https://provider.example/v1', model: 'whisper-large-v3-turbo', apiKeys: ['test-provider-key'] }) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/ai/workload.js', () => ({ acquireAiLease: vi.fn(async () => ({ release })), getAiWorkload: () => 'interactive' }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
import { describeMultimodal } from '../../../src/pipeline/multimodal.js';

const fetchMock = vi.fn();
const voice = { voiceFileId: 'test-voice-id' } as FormattedMessage;
const download = () => new Response(new Uint8Array([79, 103, 103, 83]), { headers: { 'Content-Type': 'application/octet-stream' } });
beforeEach(() => {
  vi.clearAllMocks(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  config.AUDIO_TRANSCRIBE_ENABLED = true; config.AUDIO_TRANSCRIBE_API_MODE = 'transcriptions';
  getFile.mockResolvedValue({ file_path: 'voice/file_7.oga', file_size: 4 });
});
afterEach(() => vi.unstubAllGlobals());

describe('Telegram audio transcription integration', () => {
  it('downloads Telegram bytes then sends multipart bytes only to the configured audio provider', async () => {
    fetchMock.mockResolvedValueOnce(download()).mockResolvedValueOnce(new Response(JSON.stringify({ text: '上海的语音测试成功。' })));
    expect(await describeMultimodal(voice)).toBe('[语音消息内容：上海的语音测试成功。]');
    const [fileUrl, fileOptions] = fetchMock.mock.calls[0]!;
    expect(fileUrl).toBe('https://api.telegram.org/file/bottest-telegram-token/voice/file_7.oga');
    expect(fileOptions.redirect).toBe('error'); expect(fileOptions.signal).toBeInstanceOf(AbortSignal);
    const [providerUrl, providerOptions] = fetchMock.mock.calls[1]!;
    expect(providerUrl).toBe('https://provider.example/v1/audio/transcriptions');
    expect(JSON.stringify(providerOptions.headers)).not.toContain('telegram-token');
    expect((providerOptions.body as FormData).get('file')).toMatchObject({ name: 'file_7.oga', type: 'audio/ogg', size: 4 });
    expect(chat).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
  });
  it('uses a neutral placeholder and does not download while disabled', async () => {
    config.AUDIO_TRANSCRIBE_ENABLED = false;
    expect(await describeMultimodal(voice)).toBe('[语音消息]');
    expect(getFile).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['empty', 'failure', 'timeout'])('retains a neutral placeholder on %s', async (kind) => {
    fetchMock.mockResolvedValueOnce(download());
    if (kind === 'timeout') fetchMock.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    else fetchMock.mockResolvedValueOnce(new Response(kind === 'empty' ? '{"text":""}' : 'failure', { status: kind === 'failure' ? 500 : 200 }));
    expect(await describeMultimodal(voice)).toBe('[语音消息]'); expect(release).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized Telegram metadata before download and oversized streaming bodies before upload', async () => {
    getFile.mockResolvedValueOnce({ file_path: 'voice/big.oga', file_size: 10 * 1024 * 1024 + 1 });
    expect(await describeMultimodal(voice)).toBe('[语音消息]'); expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(10 * 1024 * 1024 + 1)));
    expect(await describeMultimodal(voice)).toBe('[语音消息]'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps chat mode compatibility while treating blank chat results as empty', async () => {
    config.AUDIO_TRANSCRIBE_API_MODE = 'chat';
    fetchMock.mockResolvedValueOnce(download()); chat.mockResolvedValueOnce({ content: ' ' });
    expect(await describeMultimodal(voice)).toBe('[语音消息]');
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ usage: 'audio', maxTimeoutMs: 30_000, signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
