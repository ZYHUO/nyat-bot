import { describe, it, expect, vi, beforeEach } from 'vitest';

// P2-A 问题聚焦描述:发图带话时,描述必须覆盖用户问的内容(截图问"多少钱"
// → 通用描述只说"一张截图");且问题聚焦描述不进通用缓存,避免下次读到答非所问。

const { callMock, getDbMock } = vi.hoisted(() => ({ callMock: vi.fn(), getDbMock: vi.fn() }));

vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({
    token: 'tok',
    api: { getFile: vi.fn(async () => ({ file_path: 'photos/x.jpg' })) },
  }),
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callMock }));
vi.mock('../../../src/shared/config.js', () => ({
  loadPrompt: vi.fn(() => 'vision prompt'),
  getConfig: vi.fn(() => ({ promptsDir: 'prompts' })),
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: getDbMock }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  getStickerDescription: vi.fn(() => null),
  storeAnalysisResult: vi.fn(),
}));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { describeImage, describeImageCached, fetchImageDataUrl } from '../../../src/pipeline/vision.js';
import { logger } from '../../../src/shared/logger.js';

const fakeFetch = () =>
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    headers: { get: () => 'image/jpeg' },
  })));

beforeEach(() => {
  vi.clearAllMocks();
  callMock.mockReset();
  getDbMock.mockReset();
  fakeFetch();
  callMock.mockResolvedValue({ content: '一张商品截图,标价 39 元', model: 'v', latencyMs: 1, usage: {} });
});

describe('bounded image downloads', () => {
  it('uses a deadline and rejects redirects on the Telegram credential URL', async () => {
    expect(await fetchImageDataUrl('fid')).toMatch(/^data:image\/jpeg;base64,/);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), { signal: expect.any(AbortSignal), redirect: 'error' });
  });

  it('cancels declared oversized bodies before reading or sending them to the model', async () => {
    const cancel = vi.fn();
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'content-length': String(11 * 1024 * 1024) }), body: { cancel }, arrayBuffer })));
    expect(await describeImage('fid')).toBe('[图片]');
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('bounds streaming bodies even when no length header is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } })));
    expect(await describeImage('fid')).toBe('[图片]');
    expect(callMock).not.toHaveBeenCalled();
  });

  it('does not log file URLs embedded in transport exceptions', async () => {
    const secret = 'telegram-download-secret';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`https://api.telegram.org/file/bot${secret}/photos/x.jpg`); }));
    expect(await describeImage('fid')).toBe('[图片]');
    expect(await fetchImageDataUrl('fid')).toBeNull();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret);
  });
});

describe('describeImage 问题聚焦 (P2-A)', () => {
  it('带 question → 视觉 prompt 包含用户的话', async () => {
    await describeImage('fid', '这个多少钱');
    const userMsg = callMock.mock.calls[0]![0].messages.at(-1);
    const textPart = userMsg.content.find((p: { type: string }) => p.type === 'text');
    expect(textPart.text).toContain('这个多少钱');
    expect(textPart.text).toContain('务必覆盖');
  });

  it('不带 question → 通用描述 prompt', async () => {
    await describeImage('fid');
    const userMsg = callMock.mock.calls[0]![0].messages.at(-1);
    const textPart = userMsg.content.find((p: { type: string }) => p.type === 'text');
    expect(textPart.text).toBe('请描述这张图片。');
  });
});

describe('describeImageCached 缓存策略 (P2-A)', () => {
  it('带 question → 绕过缓存直调视觉模型,且不回写缓存', async () => {
    const prepare = vi.fn(() => ({
      get: vi.fn(() => ({ description: '旧的通用描述' })),
      run: vi.fn(),
    }));
    getDbMock.mockReturnValue({ prepare });
    const r = await describeImageCached('fid', 'uid1', '图上写了啥');
    expect(callMock).toHaveBeenCalledTimes(1); // 没读缓存
    expect(r).toContain('39 元');
  });

  it('不带 question → 命中缓存直接返回,不调视觉模型', async () => {
    const prepare = vi.fn(() => ({ get: vi.fn(() => ({ description: '缓存的描述' })) }));
    getDbMock.mockReturnValue({ prepare });
    const r = await describeImageCached('fid', 'uid1');
    expect(callMock).not.toHaveBeenCalled();
    expect(r).toBe('缓存的描述');
  });
});
