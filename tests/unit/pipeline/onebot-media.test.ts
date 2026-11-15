import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), getFile: vi.fn(), call: vi.fn(), getDb: vi.fn(), transcribe: vi.fn(), sticker: vi.fn(),
  config: { AUDIO_TRANSCRIBE_ENABLED: true, AUDIO_TRANSCRIBE_API_MODE: 'transcriptions', PDF_VISION_ENABLED: true,
    VIDEO_DESCRIBE_ENABLED: true, VIDEO_MAX_DURATION_SEC: 30, VIDEO_DESCRIBE_MAX_TOKENS: 200, VIDEO_DESCRIBE_TIMEOUT_MS: 1000 },
}));
vi.mock('../../../src/platform/onebot-media.js', () => ({ resolveOneBotMedia: mocks.resolve }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({ token: 'unused', api: { getFile: mocks.getFile } }) }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: mocks.call }));
vi.mock('../../../src/shared/config.js', () => ({ loadPrompt: () => 'vision', getConfig: () => ({ promptsDir: 'unused' }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/ai/transcription.js', () => ({ transcribeAudio: mocks.transcribe, MAX_AUDIO_BYTES: 10 * 1024 * 1024 }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getStickerDescription: mocks.sticker, storeAnalysisResult: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { processMedia } from '../../../src/pipeline/stages/media.js';
import { describeImageCached, fetchImageDataUrl } from '../../../src/pipeline/vision.js';
import { describeMultimodal } from '../../../src/pipeline/multimodal.js';

const handle = 'qq-media:11111111-1111-4111-8111-111111111111';
const chatId = -(2 ** 52 + 1);
function formatted(fields: Partial<FormattedMessage>): FormattedMessage {
  return { role: 'user', uid: 2 ** 52 + 2, username: '', fullName: 'QQ', timestamp: 1, messageId: 2 ** 52 + 3,
    textContent: '', isBot: false, isForwarded: false, ...fields };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockImplementation(async (_handle, context) => {
    if (context !== chatId) throw new Error('qq_media_wrong_context');
    return { bytes: Buffer.from('png bytes'), mimeType: 'image/png', fileName: 'image.png' };
  });
  mocks.call.mockResolvedValue({ content: '图中有一只猫' });
  mocks.transcribe.mockResolvedValue({ status: 'ok', text: '你好', label: 'test' });
});

describe('QQ bytes in the shared media stage', () => {
  it('passes source context through the actual image stage and makes the result visible to Meta', async () => {
    const message = formatted({ imageFileId: handle, imageFileUniqueId: 'cached-id', textContent: '看看这张图' });
    await processMedia(message, chatId);
    expect(mocks.resolve).toHaveBeenCalledWith(handle, chatId, expect.objectContaining({ signal: expect.any(AbortSignal), maxBytes: 10 * 1024 * 1024 }));
    expect(message.textContent).toContain('图中有一只猫');
    expect(mocks.getFile).not.toHaveBeenCalled(); expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it('cannot read a global cached description or Telegram file when QQ context is missing/wrong', async () => {
    expect(await describeImageCached(handle, 'cached-id')).toBe('[图片]');
    expect(await fetchImageDataUrl(handle, 123)).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled(); expect(mocks.getFile).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it('routes voice bytes and original scope into the existing transcription pipeline', async () => {
    mocks.resolve.mockResolvedValueOnce({ bytes: Buffer.from('mp3 bytes'), mimeType: 'audio/mpeg', fileName: 'voice.mp3' });
    const message = formatted({ voiceFileId: handle }); await processMedia(message, chatId);
    expect(message.textContent).toBe('[语音消息内容：你好]');
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'audio/mpeg', fileName: 'voice.mp3', buffer: expect.any(ArrayBuffer) }));
    expect(mocks.getFile).not.toHaveBeenCalled();
  });
  it('routes a same-chat document into the actual text extraction path', async () => {
    mocks.resolve.mockResolvedValueOnce({ bytes: Buffer.from('测试文档内容'), mimeType: 'text/plain', fileName: 'note.txt' });
    const message = formatted({ documentFileId: handle, documentFileName: 'note.txt' });
    await processMedia(message, chatId);
    expect(message.textContent).toContain('测试文档内容'); expect(mocks.getFile).not.toHaveBeenCalled();
  });
  it('routes video bytes to the existing video usage instead of a remote file URL', async () => {
    mocks.resolve.mockResolvedValueOnce({ bytes: Buffer.from('video bytes'), mimeType: 'video/mp4', fileName: 'video.mp4' });
    expect(await describeMultimodal(formatted({ videoFileId: handle, videoDurationSec: 1 }), chatId)).toContain('图中有一只猫');
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ usage: 'video' }));
    expect(JSON.stringify(mocks.call.mock.calls)).toContain('data:video/mp4;base64,');
    expect(mocks.getFile).not.toHaveBeenCalled();
  });
  it('preserves source scope for reply-to image processing', async () => {
    const message = formatted({ textContent: '这是什么', replyTo: { uid: 3, messageId: 4, fullName: 'U', textSnippet: '', imageFileId: handle } });
    await processMedia(message, chatId);
    expect(mocks.resolve).toHaveBeenCalledWith(handle, chatId, expect.any(Object));
    expect(message.textContent).toContain('图中有一只猫'); expect(mocks.getFile).not.toHaveBeenCalled();
  });
});
