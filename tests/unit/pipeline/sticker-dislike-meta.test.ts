import { beforeEach, describe, expect, it, vi } from 'vitest';

// round 8 回归：贴纸差评原来只在 legacy（tryPostMuteIntercepts ← processPipeline），
// 而"回复本喵发的贴纸 + 说不喜欢"在 Meta 上是 L0，永不进 legacy judge。
// 实测 `sticker_dislike` rule 生产 0 次、`Sticker dislike recorded` 0 次。
//
// 这三个性质必须锁住：
//   ① 回复本喵的贴纸 + 命中差评句式 → 真的记账
//   ② 回复的不是本喵 → 不拦（别把对别人的吐槽记成本喵贴纸的）
//   ③ 回复的不是贴纸 / 没命中句式 → 不拦（让模型正常回）

const lookupSentSticker = vi.fn(() => ({ fileUniqueId: 'fu_abc' }) as { fileUniqueId: string } | null);
const recordStickerDislike = vi.fn();
const getStickerScore = vi.fn(() => 0.05);
const looksLikeStickerDislike = vi.fn((t: string) => /不喜欢|换一个|丑|难看/.test(t));
const sendDirect = vi.fn(async () => {});

vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  lookupSentSticker: (...a: unknown[]) => lookupSentSticker(...a),
  recordStickerDislike: (...a: unknown[]) => recordStickerDislike(...a),
  getStickerScore: (...a: unknown[]) => getStickerScore(...a),
}));
vi.mock('../../../src/pipeline/judge/rules.js', () => ({
  looksLikeStickerDislike: (...a: unknown[]) => looksLikeStickerDislike(...(a as [string])),
}));
vi.mock('../../../src/pipeline/shared.js', () => ({ sender: { sendDirect: (...a: unknown[]) => sendDirect(...a) } }));

import { tryStickerDislikeCommand } from '../../../src/pipeline/stages/sticker-dislike-command.js';

const BOT = 8392759490;
const msg = (text: string, replyUid: number, replyMid = 555) =>
  ({ textContent: text, uid: 111, messageId: 999, replyTo: { messageId: replyMid, uid: replyUid, fullName: 'x' } }) as never;

describe('sticker-dislike 确定性拦截', () => {
  beforeEach(() => { recordStickerDislike.mockClear(); sendDirect.mockClear(); lookupSentSticker.mockClear(); getStickerScore.mockClear(); });

  it('① 回复本喵的贴纸 + 差评句式 → 记账 + 回一句', async () => {
    expect(await tryStickerDislikeCommand(-100, msg('不喜欢这个', BOT), BOT)).toBe(true);
    expect(recordStickerDislike).toHaveBeenCalledWith('fu_abc', -100, 111);
    expect(sendDirect).toHaveBeenCalled();
  });

  it('② 回复的不是本喵 → 不拦', async () => {
    expect(await tryStickerDislikeCommand(-100, msg('不喜欢这个', 222), BOT)).toBe(false);
    expect(recordStickerDislike).not.toHaveBeenCalled();
  });

  it('③ 没命中差评句式 → 不拦（让模型正常回）', async () => {
    expect(await tryStickerDislikeCommand(-100, msg('哈哈哈', BOT), BOT)).toBe(false);
    expect(recordStickerDislike).not.toHaveBeenCalled();
  });

  it('④ 回复的不是贴纸（lookup 空）→ 不拦', async () => {
    lookupSentSticker.mockReturnValueOnce(null);
    expect(await tryStickerDislikeCommand(-100, msg('不喜欢这个', BOT), BOT)).toBe(false);
    expect(recordStickerDislike).not.toHaveBeenCalled();
  });
});
