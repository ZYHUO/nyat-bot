// ────────────────────────────────────────
// Pipeline stage: media processing — vision / sticker / multimodal /
// replyTo attachments (extracted from pipeline.ts)
// ────────────────────────────────────────

import type { FormattedMessage } from "../../shared/types.js";
import { describeImage, describeImageCached, describeStickerCached } from "../vision.js";
import { describeMultimodal } from "../multimodal.js";
import { logger } from "../../shared/logger.js";

export async function processMedia(formatted: FormattedMessage): Promise<void> {
  const hasMedia = !!(
    formatted.imageFileId ||
    formatted.sticker ||
    formatted.audioFileId ||
    formatted.voiceFileId ||
    formatted.documentFileId ||
    formatted.videoFileId ||
    formatted.videoNoteFileId
  );
  if (hasMedia) {
    await Promise.all([
      formatted.imageFileId
        ? describeImageCached(formatted.imageFileId, formatted.imageFileUniqueId, formatted.textContent?.trim() || undefined)
            .then((d) => {
              if (!d) return;
              formatted.imageDescriptions = [d];
              // **也要写进 textContent**。2026-09-21 发现：生产主路径是 Meta，
              // 而 Meta 链上没有任何地方读 `imageDescriptions`——只有 legacy 的
              // `reply/prompt-builder.ts` 渲染它。于是每条图片消息都老老实实
              // 花一次 vision 调用算出描述，然后**扔掉了**：心流、Meta LLM、
              // subagent 全都看不到图里是什么。
              //
              // 与本会话反复出现的"算了没人读"同形，只是这次被扔的是 LLM 输出。
              // video/audio/document 早就走 textContent（见下面 describeMultimodal
              // 那一支），图片这一支漏了。
              //
              // 占位符 `[图片]` 不写进去——那等于告诉模型"有图但看不出什么"，
              // 而真实情况是"没算出来"，两回事。
              if (d !== '[图片]') {
                formatted.textContent = (formatted.textContent ? `${formatted.textContent}\n[图片: ${d}]` : `[图片: ${d}]`).trim();
              }
            })
            .catch((err) => logger.warn({ err }, "Vision failed, continuing"))
        : Promise.resolve(),
      formatted.sticker
        ? describeStickerCached(formatted.sticker.fileId, formatted.sticker.fileUniqueId)
            .then((d) => { if (d && d !== "[图片]") (formatted.sticker as { description?: string }).description = d; })
            .catch((err) => logger.warn({ err }, "Sticker description failed, continuing"))
        : Promise.resolve(),
      (formatted.audioFileId || formatted.voiceFileId || formatted.documentFileId || formatted.videoFileId || formatted.videoNoteFileId)
        ? describeMultimodal(formatted)
            .then((d) => { if (d) formatted.textContent = (formatted.textContent ? formatted.textContent + "\n" + d : d).trim(); })
            .catch((err) => logger.warn({ err }, "Multimodal processing failed, continuing"))
        : Promise.resolve(),
    ]);
  }

  // ReplyTo attachment — if user replies to a message with a file/image, process it
  if (formatted.replyTo && !formatted.documentFileId && !formatted.imageFileId) {
    if (formatted.replyTo.documentFileId) {
      formatted.documentFileId = formatted.replyTo.documentFileId;
      formatted.documentMimeType = formatted.replyTo.documentMimeType;
      formatted.documentFileName = formatted.replyTo.documentFileName;
      try {
        const desc = await describeMultimodal(formatted);
        if (desc) {
          formatted.textContent = (formatted.textContent ? formatted.textContent + "\n" + desc : desc).trim();
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo document processing failed, continuing");
      }
      formatted.documentFileId = undefined;
    } else if (formatted.replyTo.imageFileId) {
      try {
        // 用户回复一张图说话(如"这个多少钱")→ 问题聚焦描述,别给泛泛概述
        const description = await describeImage(formatted.replyTo.imageFileId, formatted.textContent?.trim() || undefined);
        if (description) {
          formatted.imageDescriptions = [description];
          // **也要进 textContent**。round 34 只修了上面的直接发图那一支，
          // 漏了这一支——用户**回复一张图**问"这个多少钱"时，描述同样只进了
          // imageDescriptions，Meta 路径读不到，模型瞎答。
          // 同一条规则：Meta 只读 textContent，凡是算了给模型看的东西都得在那儿。
          if (description !== '[图片]') {
            formatted.textContent = (formatted.textContent ? `${formatted.textContent}\n[图片: ${description}]` : `[图片: ${description}]`).trim();
          }
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo image processing failed, continuing");
      }
    }
  }
}
