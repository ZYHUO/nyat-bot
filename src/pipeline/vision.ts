// ────────────────────────────────────────
// 图片描述 — Vision model
// ────────────────────────────────────────

import { getBot } from '../bot/bot.js';
import { callWithFallback } from '../ai/fallback.js';
import { loadPrompt, getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getStickerDescription, storeAnalysisResult } from '../knowledge/sticker/store.js';

/**
 * Describe an image via vision model.
 * Downloads from Telegram, sends to vision model, returns description.
 */
export async function describeImage(fileId: string): Promise<string> {
  try {
    // 1. Get file URL from Telegram
    const bot = getBot();
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;

    if (!filePath) {
      logger.warn({ fileId }, 'No file_path returned from Telegram');
      return '[图片]';
    }

    // Skip animated stickers (WebM/TGS) — not supported by image vision models
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'webm' || ext === 'tgs') {
      logger.debug({ fileId, filePath }, 'Skipping animated sticker (not a static image)');
      return '[动态贴纸]';
    }

    // 2. Build download URL
    const token = bot.token;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    // 3. Download image
    const response = await fetch(fileUrl);
    if (!response.ok) {
      logger.warn({ fileId, status: response.status }, 'Failed to download image from Telegram');
      return '[图片]';
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    let mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    // Telegram serves sticker files as application/octet-stream — detect WebP by magic bytes
    if (mimeType === 'application/octet-stream' || mimeType.includes('octet')) {
      const bytes = new Uint8Array(buffer.slice(0, 4));
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        mimeType = 'image/webp'; // RIFF header = WebP
      } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        mimeType = 'image/png';  // PNG
      } else {
        mimeType = 'image/webp'; // default for stickers
      }
    }
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // 4. Load vision prompt
    const config = getConfig();
    const visionPrompt = loadPrompt('task/vision.md', config.promptsDir);

    // 5. Call vision model
    const result = await callWithFallback({
      usage: 'vision',
      messages: [
        { role: 'system', content: visionPrompt },
        {
          role: 'user',
          content: [
            { type: 'image', image: dataUrl },
            { type: 'text', text: '请描述这张图片。' },
          ],
        },
      ],
      maxTokens: 200,
    });

    const description = result.content.trim();
    logger.debug({ fileId, descLength: description.length }, 'Image described');
    return description || '[图片]';
  } catch (err) {
    logger.warn({ fileId, err }, 'Vision failed, returning placeholder');
    return '[图片]';
  }
}

/**
 * Describe a sticker with SQLite cache.
 * Checks description cache first; falls back to vision model if not found.
 * Never reads sticker emoji for description.
 */
export async function describeStickerCached(fileId: string, fileUniqueId: string): Promise<string> {
  // Check cache
  const cached = getStickerDescription(fileUniqueId);
  if (cached) {
    logger.debug({ fileUniqueId }, 'Sticker description cache hit');
    return cached;
  }

  // No cache — call vision model
  const description = await describeImage(fileId);

  // Store in cache (only if we got a real description)
  if (description && description !== '[图片]') {
    try {
      storeAnalysisResult(fileUniqueId, { description });
    } catch (err) {
      logger.warn({ err, fileUniqueId }, 'Failed to cache sticker description');
    }
  }

  return description;
}
