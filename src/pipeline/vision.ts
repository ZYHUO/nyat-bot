// ────────────────────────────────────────
// 图片描述 — Vision model
// ────────────────────────────────────────

import { getBot } from '../bot/bot.js';
import { callWithFallback } from '../ai/fallback.js';
import { loadPrompt, getConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getDb } from '../db/sqlite.js';
import { getStickerDescription, storeAnalysisResult } from '../knowledge/sticker/store.js';

/** 下载 Telegram 图片为 data URL(静态图;webm/tgs 返回 null)。供描述/识图/回复直读复用。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function downloadStaticImage(fileId: string, chatId?: number): Promise<{ dataUrl: string | null; animated: boolean }> {
  const signal = AbortSignal.timeout(30_000);
  if (fileId.startsWith('qq-media:')) {
    const { resolveOneBotMedia } = await import('../platform/onebot-media.js');
    const media = await resolveOneBotMedia(fileId, chatId, { signal, maxBytes: MAX_IMAGE_BYTES });
    if (!media.mimeType.startsWith('image/')) return { dataUrl: null, animated: false };
    return { dataUrl: `data:${media.mimeType};base64,${media.bytes.toString('base64')}`, animated: false };
  }
  const bot = getBot();
  // grammY pins the abort-controller type, but accepts native Node 22 signals.
  const file = await bot.api.getFile(fileId, signal as unknown as Parameters<typeof bot.api.getFile>[1]);
  const filePath = file.file_path;
  if (!filePath) return { dataUrl: null, animated: false };
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'webm' || ext === 'tgs') return { dataUrl: null, animated: true };
  if (file.file_size && file.file_size > MAX_IMAGE_BYTES) return { dataUrl: null, animated: false };
  const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${filePath}`;
  const response = await fetch(fileUrl, { signal, redirect: 'error' });
  if (!response.ok) return { dataUrl: null, animated: false };
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    return { dataUrl: null, animated: false };
  }
  const reader = response.body?.getReader();
  let buffer: ArrayBuffer;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return { dataUrl: null, animated: false }; }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    buffer = bytes.buffer;
  } else buffer = await response.arrayBuffer();
  if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) return { dataUrl: null, animated: false };
  const base64 = Buffer.from(buffer).toString('base64');
  let mimeType = response.headers.get('content-type') ?? 'image/jpeg';
  if (mimeType.includes('octet')) {
    const b = new Uint8Array(buffer.slice(0, 4));
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) mimeType = 'image/webp';
    else if (b[0] === 0x89 && b[1] === 0x50) mimeType = 'image/png';
    else mimeType = 'image/jpeg';
  }
  return { dataUrl: `data:${mimeType};base64,${base64}`, animated: false };
}

export async function fetchImageDataUrl(fileId: string, chatId?: number): Promise<string | null> {
  try { return (await downloadStaticImage(fileId, chatId)).dataUrl; }
  catch {
    // Telegram download errors can include the credential-bearing file URL.
    logger.warn({ fileId }, 'Image download failed');
    return null;
  }
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
export async function analyzeStickerEmotion(fileId: string, chatId?: number): Promise<StickerEmotion | null> {
  try {
    const dataUrl = await fetchImageDataUrl(fileId, chatId);
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
      maxTokens: 4000,
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
 * @param question 用户发图时附带的话(P2 问题聚焦):通用描述常常漏掉用户真正问的
 *  细节(截图问"多少钱"→ 描述只说"一张截图")。带上它让描述覆盖相关内容。
 */
export async function describeImage(fileId: string, question?: string, chatId?: number): Promise<string> {
  try {
    const { dataUrl, animated } = await downloadStaticImage(fileId, chatId);
    if (animated) return '[动态贴纸]';
    if (!dataUrl) return '[图片]';

    // 4. Load vision prompt
    const config = getConfig();
    const visionPrompt = loadPrompt('task/vision.md', config.promptsDir);

    // 5. Call vision model(带用户的问题时,描述聚焦相关内容)
    const q = question?.trim().slice(0, 300);
    const askText = q
      ? `请描述这张图片。用户发图时还说：「${q}」——描述时务必覆盖与这句话相关的内容（如图中文字、价格、型号、界面细节），别只给泛泛概述。`
      : '请描述这张图片。';
    const result = await callWithFallback({
      usage: 'vision',
      messages: [
        { role: 'system', content: visionPrompt },
        {
          role: 'user',
          content: [
            { type: 'image', image: dataUrl },
            { type: 'text', text: askText },
          ],
        },
      ],
      maxTokens: 4000,
    });

    const description = result.content.trim();
    logger.debug({ fileId, descLength: description.length }, 'Image described');
    return description || '[图片]';
  } catch {
    logger.warn({ fileId }, 'Vision failed, returning placeholder');
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
 * 带 question 的问题聚焦描述**不进缓存**:它是针对当次提问定制的,缓存会让
 * 同一张图下次被问到别的内容时读到答非所问的旧描述。
 */
export async function describeImageCached(fileId: string, fileUniqueId?: string, question?: string, chatId?: number): Promise<string> {
  const q = question?.trim();
  // An opaque QQ handle is conversation-scoped; a global cache cannot authorize it.
  if (fileId.startsWith('qq-media:') || !fileUniqueId || q) return describeImage(fileId, q, chatId);
  const cached = getImageDescription(fileUniqueId);
  if (cached) {
    logger.debug({ fileUniqueId }, 'Image description cache hit');
    return cached;
  }
  const description = await describeImage(fileId, undefined, chatId);
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
export async function describeStickerCached(fileId: string, fileUniqueId: string, chatId?: number): Promise<string> {
  if (fileId.startsWith('qq-media:')) return describeImage(fileId, undefined, chatId);
  // Check cache
  const cached = getStickerDescription(fileUniqueId);
  if (cached) {
    logger.debug({ fileUniqueId }, 'Sticker description cache hit');
    return cached;
  }

  // No cache — call vision model
  const description = await describeImage(fileId, undefined, chatId);

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
