/**
 * `processMedia` —— Meta 主路径的媒体处理阶段。
 *
 * 2026-09-21 发现这个模块**零测试 import**，而它正是生产主路径上处理媒体的地方
 * （`message.ts:741`，media-heavy 消息走这里再进 finishMeta），也是本轮修
 * "图片描述算了但被扔掉"的位置。
 *
 * 这里锁三件事：
 *   ① 图片描述既进 `imageDescriptions`（legacy 读者）也进 `textContent`（Meta 读者）
 *      —— 少任何一头都有一边看不到图
 *   ② 占位符 `[图片]` 不进 textContent（"没算出来"≠"有图但看不出什么"）
 *   ③ 任一 describe 抛错不往外抛（媒体处理失败不该拦住 ingest）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../../src/shared/types.js';

const mocks = vi.hoisted(() => ({
  describeImageCached: vi.fn(),
  describeStickerCached: vi.fn(),
  describeMultimodal: vi.fn(),
  describeImage: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../src/pipeline/vision.js', () => ({
  describeImage: mocks.describeImage,
  describeImageCached: mocks.describeImageCached,
  describeStickerCached: mocks.describeStickerCached,
}));
vi.mock('../../../../src/pipeline/multimodal.js', () => ({
  describeMultimodal: mocks.describeMultimodal,
}));
vi.mock('../../../../src/shared/logger.js', () => ({ logger: mocks.logger }));

const { processMedia } = await import('../../../../src/pipeline/stages/media.js');

function fm(over: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user', uid: 111, username: 'u', fullName: 'U',
    messageId: 1, timestamp: 0, isForwarded: false, isBot: false,
    textContent: '', ...over,
  } as FormattedMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.describeImageCached.mockResolvedValue('一张猫咪表情包');
  mocks.describeStickerCached.mockResolvedValue('开心贴纸');
  mocks.describeMultimodal.mockResolvedValue('[视频内容：一只猫在跳]');
  mocks.describeImage.mockResolvedValue('回复里的图');
});

describe('processMedia · 图片', () => {
  it('① 描述既进 imageDescriptions 也进 textContent', async () => {
    const f = fm({ imageFileId: 'IMG1', imageUniqueId: 'U1' });
    await processMedia(f);
    expect(f.imageDescriptions).toEqual(['一张猫咪表情包']);
    // 这一条是 round 34 修的：Meta 路径只读 textContent
    expect(f.textContent).toBe('[图片: 一张猫咪表情包]');
  });

  it('①b 有 caption 时描述接在 caption 后面（不覆盖用户的话）', async () => {
    const f = fm({ imageFileId: 'IMG1', imageUniqueId: 'U1', textContent: '看这个' });
    await processMedia(f);
    expect(f.textContent).toBe('看这个\n[图片: 一张猫咪表情包]');
  });

  it('② 占位符 [图片] 不进 textContent（没算出来 ≠ 看得出但没内容）', async () => {
    mocks.describeImageCached.mockResolvedValue('[图片]');
    const f = fm({ imageFileId: 'IMG1', imageUniqueId: 'U1', textContent: '看这个' });
    await processMedia(f);
    expect(f.imageDescriptions).toEqual(['[图片]']);
    expect(f.textContent).toBe('看这个');   // 不加一行废话
  });

  it('②b describeImageCached 抛错 → 不往外抛，textContent 不动', async () => {
    mocks.describeImageCached.mockRejectedValue(new Error('vision boom'));
    const f = fm({ imageFileId: 'IMG1', imageUniqueId: 'U1', textContent: '看这个' });
    await expect(processMedia(f)).resolves.toBeUndefined();
    expect(f.textContent).toBe('看这个');
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});

describe('processMedia · 其他媒体', () => {
  it('③ 视频描述进 textContent', async () => {
    const f = fm({ videoFileId: 'V1', videoDurationSec: 8 });
    await processMedia(f);
    expect(f.textContent).toBe('[视频内容：一只猫在跳]');
  });

  it('③b 音频/语音/文档也走 describeMultimodal', async () => {
    for (const key of ['audioFileId', 'voiceFileId', 'documentFileId'] as const) {
      mocks.describeMultimodal.mockClear();
      const f = fm({ [key]: 'X1' } as Partial<FormattedMessage>);
      await processMedia(f);
      expect(mocks.describeMultimodal, key).toHaveBeenCalledTimes(1);
      expect(f.textContent, key).toBe('[视频内容：一只猫在跳]');
    }
  });

  it('③c describeMultimodal 返回 null → textContent 不被写成 "null"', async () => {
    mocks.describeMultimodal.mockResolvedValue(null);
    const f = fm({ videoFileId: 'V1' });
    await processMedia(f);
    expect(f.textContent).toBe('');
  });

  it('④ 贴纸描述挂回 sticker 对象', async () => {
    const f = fm({ sticker: { fileId: 'S1', fileUniqueId: 'SU1', emoji: '😀', setName: 'x' } as never });
    await processMedia(f);
    expect((f.sticker as { description?: string }).description).toBe('开心贴纸');
  });

  it('④b 贴纸占位符不挂描述', async () => {
    mocks.describeStickerCached.mockResolvedValue('[图片]');
    const f = fm({ sticker: { fileId: 'S1', fileUniqueId: 'SU1' } as never });
    await processMedia(f);
    expect((f.sticker as { description?: string }).description).toBeUndefined();
  });

  it('⑤ 无媒体 → 完全不调 describe（不白烧）', async () => {
    const f = fm({ textContent: '纯文字' });
    await processMedia(f);
    expect(mocks.describeImageCached).not.toHaveBeenCalled();
    expect(mocks.describeMultimodal).not.toHaveBeenCalled();
    expect(f.textContent).toBe('纯文字');
  });

  it('⑥ 回复的图片也会被描述（回复一张图说话）', async () => {
    const f = fm({
      textContent: '这个多少钱',
      replyTo: { uid: 222, messageId: 5, imageFileId: 'RIMG' } as never,
    });
    await processMedia(f);
    expect(mocks.describeImage).toHaveBeenCalledWith('RIMG', '这个多少钱');
    expect(f.textContent).toBe('这个多少钱\n[图片: 回复里的图]');
  });
});
