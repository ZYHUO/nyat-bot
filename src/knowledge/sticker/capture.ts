// ────────────────────────────────────────
// StickerCapture — extracts sticker usage context from incoming messages
// Port of PHP StickerCaptureService
// ────────────────────────────────────────

import { recordStickerUsage } from './store.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';
import type { StickerFormat, StickerMeta } from './types.js';

const CONTEXT_WINDOW = 5;

export function captureSticker(
  message: FormattedMessage,
  chatId: number,
  recentContext: FormattedMessage[],
): void {
  const sticker = message.sticker;
  if (!sticker?.fileId) return;

  const fileUniqueId = sticker.fileUniqueId;
  if (!fileUniqueId) return;

  const format = detectFormat(sticker);

  const meta: StickerMeta = {
    fileUniqueId,
    fileId: sticker.fileId,
    setName: sticker.setName ?? null,
    emoji: sticker.emoji ?? null,
    stickerFormat: format,
  };

  const contextBefore = recentContext
    .slice(-CONTEXT_WINDOW)
    .map((m) => ({
      uid: m.uid,
      username: m.username,
      text: m.textContent?.slice(0, 200),
    }));

  try {
    recordStickerUsage(meta, {
      fileUniqueId: meta.fileUniqueId,
      chatId,
      messageId: message.messageId,
      date: message.timestamp,
      fromUserId: message.uid || null,
      username: message.username || null,
      replyToMessageId: message.replyTo?.messageId ?? null,
      replyTargetText: message.replyTo?.textSnippet ?? null,
      contextBefore: JSON.stringify(contextBefore),
    });
  } catch (err) {
    logger.warn({ err, fileUniqueId: meta.fileUniqueId }, 'Sticker capture failed');
  }
}

function detectFormat(
  sticker: NonNullable<FormattedMessage['sticker']>,
): StickerFormat {
  if (sticker.isVideo) return 'video_webm';
  if (sticker.isAnimated) return 'animated_tgs';
  return 'static_webp';
}
