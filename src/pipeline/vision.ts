// ────────────────────────────────────────
// 图片描述 — Vision model
// ────────────────────────────────────────

import { getBot } from '../bot/bot.js';
import { callWithFallback } from '../ai/fallback.js';
import { loadPrompt, getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getDb } from '../db/sqlite.js';
import { getStickerDescription, storeAnalysisResult } from '../knowledge/sticker/store.js';

/** 下载 Telegram 图片为 data URL(静态图;webm/tgs 返回 null)。供描述/识图复用。 */
async function fetchImageDataUrl(fileId: string): Promise<string | null> {
  const bot = getBot();
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) return null;
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'webm' || ext === 'tgs') return null; // 动态:调用方应传缩略图 file_id
  const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  let mimeType = response.headers.get('content-type') ?? 'image/jpeg';
  if (mimeType.includes('octet')) {
    const b = new Uint8Array(buffer.slice(0, 4));
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) mimeType = 'image/webp';
    else if (b[0] === 0x89 && b[1] === 0x50) mimeType = 'image/png';
    else mimeType = 'image/jpeg';
  }
  return `data:${mimeType};base64,${base64}`;
}

export interface StickerEmotion {
  emotionTags: string[];
  moodMap: Record<string, number>;
  personaFit: boolean;
  description: string;
}

/**
 * 识图分析一张贴纸的情绪(供常驻贴纸入库)。走视觉模型,返回结构化情绪标签 +
 * mood_map + 是否适配猫娘人设 + 描述。失败返回 null。emoji 不作参考(全靠看图)。
 */
export async function analyzeStickerEmotion(fileId: string): Promise<StickerEmotion | null> {
  try {
    const dataUrl = await fetchImageDataUrl(fileId);
    if (!dataUrl) return null;
    const prompt =
      'Label this sticker for a cute catgirl bot\'s sticker library. Look ONLY at the image — ignore any emoji. ' +
      'Output STRICT JSON only (no prose): {"emotion_tags":["happy","shy"],"mood_map":{"happy":0.8,"shy":0.4},' +
      '"persona_fit":true,"description":"one short line"}. ' +
      'emotion_tags: 3-6 lowercase ENGLISH emotion/scene words from this vocabulary when possible: ' +
      'cute, happy, sad, angry, surprised, shy, flustered, embarrassed, confused, playful, teasing, smug, ' +
      'sleepy, tired, comforting, gentle, soft, affectionate, pouty, deadpan, unimpressed, sarcastic, crying, ' +
      'excited, cheerful, curious, nervous, awkward, calm, peaceful, warmth, greeting, farewell, thanking. ' +
      'mood_map: 0-1 values. persona_fit=false if ugly/adult/plain-text-screenshot.';
    const result = await callWithFallback({
      usage: 'vision',
      messages: [
        { role: 'user', content: [{ type: 'image', image: dataUrl }, { type: 'text', text: prompt }] },
      ],
      maxTokens: 300,
    });
    const raw = result.content.trim();
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as {
      emotion_tags?: unknown; mood_map?: unknown; persona_fit?: unknown; description?: unknown;
    };
    const emotionTags = Array.isArray(parsed.emotion_tags)
      ? parsed.emotion_tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : [];
    const moodMap: Record<string, number> = {};
    if (parsed.mood_map && typeof parsed.mood_map === 'object') {
      for (const [k, v] of Object.entries(parsed.mood_map as Record<string, unknown>)) {
        if (typeof v === 'number') moodMap[k] = Math.max(0, Math.min(1, v));
      }
    }
    if (emotionTags.length === 0 && Object.keys(moodMap).length === 0) return null;
    return {
      emotionTags,
      moodMap,
      personaFit: parsed.persona_fit !== false,
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 200) : '',
    };
  } catch (err) {
    logger.debug({ fileId, err }, 'analyzeStickerEmotion failed');
    return null;
  }
}

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
      maxTokens: 300,
    });

    const description = result.content.trim();
    logger.debug({ fileId, descLength: description.length }, 'Image described');
    return description || '[图片]';
  } catch (err) {
    logger.warn({ fileId, err }, 'Vision failed, returning placeholder');
    return '[图片]';
  }
}

/** Read a cached image description by file_unique_id. */
export function getImageDescription(fileUniqueId: string): string | null {
  try {
    const row = getDb().prepare(
      'SELECT description FROM image_descriptions WHERE file_unique_id = ?',
    ).get(fileUniqueId) as { description: string } | undefined;
    return row?.description ?? null;
  } catch {
    return null;
  }
}

function saveImageDescription(fileUniqueId: string, description: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO image_descriptions (file_unique_id, description, created_at) VALUES (?, ?, unixepoch())',
  ).run(fileUniqueId, description);
}

/**
 * Describe an image with a SQLite cache keyed by file_unique_id (stable across
 * links). Reposted/forwarded images reuse their description instead of being
 * re-downloaded and re-VLM'd. Falls back to a plain describe when no unique id.
 */
export async function describeImageCached(fileId: string, fileUniqueId?: string): Promise<string> {
  if (!fileUniqueId) return describeImage(fileId);
  const cached = getImageDescription(fileUniqueId);
  if (cached) {
    logger.debug({ fileUniqueId }, 'Image description cache hit');
    return cached;
  }
  const description = await describeImage(fileId);
  if (description && description !== '[图片]') {
    try { saveImageDescription(fileUniqueId, description); }
    catch (err) { logger.warn({ err, fileUniqueId }, 'Failed to cache image description'); }
  }
  return description;
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
