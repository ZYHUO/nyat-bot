/**
 * 视频理解（describeVideo）。
 *
 * 2026-09-21：`multimodal.ts` 里原来只有一行
 * `[视频：用户发送了一段视频]` + "description not supported yet"。
 * 那个判断**曾经是对的，现在过期了**——实测 step-5-preview 吃 base64 video_url，
 * 6 秒测试视频准确描述了内容。
 *
 * 这里锁的是这次接线上几个会静默出错的地方：
 *   ① 超时长 → 不下载、不调 LLM（下载 + base64 + reasoning 都要花钱）
 *   ② 开关关 / 下载失败 / LLM 失败 → **中性占位**，不写"无法识别"
 *      （那会让 bot 把群友发的视频误读成自己出了故障）
 *   ③ MIME 从文件扩展名兜底（Telegram file 端点常回 application/octet-stream）
 *   ④ 走独立 `video` usage，不蹭 vision 链
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envValues: Record<string, unknown> = {
  VIDEO_DESCRIBE_ENABLED: true,
  VIDEO_MAX_DURATION_SEC: 300,
  VIDEO_DESCRIBE_MAX_TOKENS: 2000,
  VIDEO_DESCRIBE_TIMEOUT_MS: 120000,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 假的 Telegram 文件：path 决定 MIME 兜底，buffer 是假视频字节
const FAKE_MP4 = Buffer.from('fake-mp4-bytes');
const getFileMock = vi.fn(async () => ({
  file_path: 'video/file_123.mp4',
  file_size: FAKE_MP4.byteLength,
}));
const fetchMock = vi.fn(async () => ({
  ok: true,
  arrayBuffer: async () => FAKE_MP4.buffer.slice(FAKE_MP4.byteOffset, FAKE_MP4.byteOffset + FAKE_MP4.byteLength),
  headers: { get: () => 'application/octet-stream' }, // Telegram 经常不猜类型
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({ token: 'test-token', api: { getFile: (...a: unknown[]) => getFileMock(...a) } }),
  getBotUid: () => 999,
}));
vi.stubGlobal('fetch', fetchMock);

const callWithFallbackMock = vi.fn(async () => ({ content: '两个人在打游戏，一直在喊"救我"。', label: 'step5', model: 'step-5-preview' }));
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...a: unknown[]) => callWithFallbackMock(...a),
}));

const { describeMultimodal } = await import('../../../src/pipeline/multimodal.js');
const { formatMessage } = await import('../../../src/pipeline/formatter.js');

beforeEach(() => {
  vi.clearAllMocks();
  envValues.VIDEO_DESCRIBE_ENABLED = true;
  envValues.VIDEO_MAX_DURATION_SEC = 300;
  fetchMock.mockResolvedValue({
    ok: true,
    arrayBuffer: async () => FAKE_MP4.buffer.slice(FAKE_MP4.byteOffset, FAKE_MP4.byteOffset + FAKE_MP4.byteLength),
    headers: { get: () => 'application/octet-stream' },
  } as never);
});

const videoMsg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  messageId: 500,
  uid: 777,
  textContent: '',
  videoFileId: 'vid-file-1',
  videoDurationSec: 12,
  ...over,
});

describe('describeMultimodal · 视频', () => {
  it('① 短视频 + 开关开 → 真描述，走独立 video usage', async () => {
    const out = await describeMultimodal(videoMsg() as never);
    expect(out).toContain('[视频内容：');
    expect(out).toContain('打游戏');
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    const arg = callWithFallbackMock.mock.calls[0]![0] as {
      usage: string;
      maxTokens: number;
      maxTimeoutMs: number;
      messages: Array<{ content: Array<{ type: string; video_url?: { url: string } }> }>;
    };
    expect(arg.usage).toBe('video');            // 不蹭 vision 链
    expect(arg.maxTokens).toBe(2000);           // reasoning 计入 completion，给小了得空正文
    expect(arg.maxTimeoutMs).toBe(120000);
    const parts = arg.messages[0]!.content;
    const vp = parts.find((p) => p.type === 'video_url');
    expect(vp).toBeTruthy();
    // base64 data URL，且 MIME 从扩展名兜底（响应头是 octet-stream）
    expect(vp!.video_url!.url.startsWith('data:video/mp4;base64,')).toBe(true);
    // **不能**把 Telegram file URL 直接喂供应商——那URL里带着 bot token
    expect(vp!.video_url!.url).not.toContain('api.telegram.org');
  });

  it('② 超时长 → 不下载、不调 LLM，占位带时长', async () => {
    const out = await describeMultimodal(videoMsg({ videoDurationSec: 900 }) as never);
    expect(out).toBe('[视频（900 秒，超过 300 秒不上传）]');
    expect(getFileMock).not.toHaveBeenCalled();
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('②b 刚好等于上限 → 照常处理（上限是"超过才拦"）', async () => {
    await describeMultimodal(videoMsg({ videoDurationSec: 300 }) as never);
    expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
  });

  it('③ 开关关 → 中性占位，不调 LLM', async () => {
    envValues.VIDEO_DESCRIBE_ENABLED = false;
    const out = await describeMultimodal(videoMsg() as never);
    expect(out).toBe('[视频（12 秒）]');
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });

  it('④ 下载失败 → 中性占位，不写"无法识别"', async () => {
    fetchMock.mockResolvedValue({ ok: false, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => '' } } as never);
    const out = await describeMultimodal(videoMsg() as never);
    expect(out).toBe('[视频（12 秒）]');
    expect(out).not.toContain('无法');
  });

  it('④b LLM 抛错 → 同样中性占位', async () => {
    callWithFallbackMock.mockRejectedValueOnce(new Error('provider 400'));
    const out = await describeMultimodal(videoMsg() as never);
    expect(out).toBe('[视频（12 秒）]');
    expect(out).not.toContain('无法');
  });

  it('④c LLM 返回空正文 → 中性占位（不把空串塞进上下文）', async () => {
    callWithFallbackMock.mockResolvedValueOnce({ content: '   ', label: 'x', model: 'y' } as never);
    const out = await describeMultimodal(videoMsg() as never);
    expect(out).toBe('[视频（12 秒）]');
  });

  it('⑤ 圆形视频（video_note）用"圆形视频"标签', async () => {
    const out = await describeMultimodal(
      videoMsg({ videoFileId: undefined, videoNoteFileId: 'vn-1', videoDurationSec: 8 }) as never,
    );
    expect(out).toContain('[圆形视频内容：');
  });

  it('⑥ 没有时长信息也照常跑（不因为缺字段就跳过）', async () => {
    const out = await describeMultimodal(videoMsg({ videoDurationSec: undefined }) as never);
    expect(out).toContain('[视频内容：');
  });

  it('⑦ 其他媒体不受影响（图片/语音/文档路径没被带坏）', async () => {
    // 没有视频 → 不该碰 video 这条路
    const out = await describeMultimodal({ messageId: 1, uid: 2, textContent: 'hi' } as never);
    expect(out).toBeNull();
    expect(callWithFallbackMock).not.toHaveBeenCalled();
  });
});

describe('formatter · 视频时长接住', () => {
  it('video 的 duration 进 FormattedMessage', () => {
    const fm = formatMessage({
      message: {
        message_id: 900,
        from: { id: 1, first_name: 'A', is_bot: false },
        chat: { id: -100, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        video: { file_id: 'v1', file_unique_id: 'u1', duration: 42, mime_type: 'video/mp4' },
      },
    } as never);
    expect(fm.videoFileId).toBe('v1');
    expect(fm.videoDurationSec).toBe(42);
  });

  it('video_note 的 duration 也接住', () => {
    const fm = formatMessage({
      message: {
        message_id: 901,
        from: { id: 1, first_name: 'A', is_bot: false },
        chat: { id: -100, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        video_note: { file_id: 'vn1', file_unique_id: 'u2', duration: 7 },
      },
    } as never);
    expect(fm.videoNoteFileId).toBe('vn1');
    expect(fm.videoDurationSec).toBe(7);
  });

  it('duration 缺失/为 0 时不设字段（不拿 0 当"0 秒视频"）', () => {
    const fm = formatMessage({
      message: {
        message_id: 902,
        from: { id: 1, first_name: 'A', is_bot: false },
        chat: { id: -100, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        video: { file_id: 'v2', file_unique_id: 'u3', duration: 0 },
      },
    } as never);
    expect(fm.videoFileId).toBe('v2');
    expect(fm.videoDurationSec).toBeUndefined();
  });
});
