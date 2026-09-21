// ─────────────────────────────────────────────────────────────────────
// 贴纸差评拦截 —— 确定性路径（不经过模型）
// ─────────────────────────────────────────────────────────────────────
//
// 2026-09-22 round 8。和 round 3 的 `antiad-command.ts` 同一种病：
// 这段逻辑原来只在 **legacy** 的 `pipeline/stages/intercepts.ts:226`
// （`tryPostMuteIntercepts` ← `post-judge.ts:492` ← `processPipeline`）。
// 而"回复本喵发的贴纸 + 说句不喜欢"这条消息在 Meta 主路径上是 L0
// （classify-layer.ts：reply-to-bot = L0），**永远不进 legacy 的 judge**，
// 于是 `sticker_dislike` 这条 rule 生产 0 次、
// `Sticker dislike recorded` 生产 0 次。
//
// 为什么值得接：模型当然能 conversational 地回一句"好的不发了"，
// 但它**不会**调 `recordStickerDislike`——那是个纯数据动作（贴纸评分下降）。
// 不接的后果是 bot 继续用那个被差评的贴纸，而它以为用户知道它改了。
//
// 判据刻意和 legacy 那道一致：必须是**回复本喵发过的贴纸** + 文本命中
// `looksLikeStickerDislike`。别的地方不拦——否则"这个表情好丑"这种
// 泛泛的吐槽会把无关贴纸记一笔。

import type { FormattedMessage } from '../../shared/types.js';
import { logger } from '../../shared/logger.js';
import { looksLikeStickerDislike } from '../judge/rules.js';

/** 认出"这是在对本喵发的贴纸表达差评"就办。返回 true = 已处理（调用方应短路）。 */
export async function tryStickerDislikeCommand(
  chatId: number,
  formatted: FormattedMessage,
  botUid: number,
): Promise<boolean> {
  // 必须是回复，且回复的是本喵
  const reply = formatted.replyTo;
  if (!reply || reply.uid !== botUid) return false;

  const text = (formatted.textContent || formatted.captionContent || '').trim();
  if (!text || !looksLikeStickerDislike(text)) return false;

  try {
    const { lookupSentSticker, recordStickerDislike, getStickerScore } =
      await import('../../knowledge/sticker/store.js');
    const sent = lookupSentSticker(chatId, reply.messageId);
    if (!sent) return false;   // 回复的不是贴纸（可能是文字/图片）→ 不拦，让模型正常回

    recordStickerDislike(sent.fileUniqueId, chatId, formatted.uid);
    const score = getStickerScore(sent.fileUniqueId);
    const { sender } = await import('../shared.js');
    const ack = score <= 0.1
      ? '好的，这个贴纸不会再出现了喵~'
      : '知道了，下次少用这个贴纸~';
    await sender.sendDirect(chatId, ack, formatted.messageId);
    logger.info(
      { chatId, fileUniqueId: sent.fileUniqueId, newScore: score, userId: formatted.uid },
      'Sticker dislike recorded (Meta deterministic path)',
    );
    return true;
  } catch (err) {
    logger.debug({ err, chatId }, 'sticker-dislike intercept failed (non-critical)');
    return false;   // 办失败不短路，让模型还有一次机会
  }
}
