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
            .then((d) => { if (d) formatted.imageDescriptions = [d]; })
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
        }
      } catch (err) {
        logger.warn({ err }, "ReplyTo image processing failed, continuing");
      }
    }
  }
}
