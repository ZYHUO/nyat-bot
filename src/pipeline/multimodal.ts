// ────────────────────────────────────────
// Multimodal Processor — describe audio, documents, video
// ────────────────────────────────────────

import { getBot } from '../bot/bot.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';

// MaiBot 借鉴:超大文件直接丢弃 —— 发给 LLM 会 413/超时,卡住整条管线。
// Telegram 文件上限 50MB,base64 后 ×1.33;10MB 已远超任何视觉模型需要。
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

async function downloadTelegramFile(
  fileId: string,
): Promise<{ buffer: ArrayBuffer; mimeType: string; filePath: string } | null> {
  try {
    const bot = getBot();
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) return null;
    if (file.file_size && file.file_size > MAX_MEDIA_BYTES) {
      logger.info({ fileId, fileSize: file.file_size }, 'Media too large, skipping download');
      return null;
    }

    const token = bot.token;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_MEDIA_BYTES) {
      logger.info({ fileId, bytes: buffer.byteLength }, 'Media too large after download, dropping');
      return null;
    }
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
    return { buffer, mimeType, filePath };
  } catch (err) {
    logger.warn({ fileId, err }, 'downloadTelegramFile failed');
    return null;
  }
}

/** Telegram audio MIME → OpenAI input_audio container format */
function audioFormatFromMime(mime: string): string {
  const sub = mime.split('/')[1]?.split(';')[0]?.toLowerCase() ?? 'ogg';
  if (sub === 'mpeg' || sub === 'mp3') return 'mp3';
  if (sub === 'x-m4a' || sub === 'mp4' || sub === 'aac') return 'm4a';
  if (sub === 'wav' || sub === 'x-wav' || sub === 'wave') return 'wav';
  if (sub === 'opus' || sub === 'ogg') return 'ogg';
  return sub;
}

async function describeAudio(fileId: string, label: string): Promise<string> {
  const downloaded = await downloadTelegramFile(fileId);
  // 下不动(多半文件太大)≠ 内容不存在:文件已在群里、别人收得到。用中性占位,
  // 别写"无法下载"——否则 bot 会把别的 bot 发来的歌/语音误读成"失败了"。
  if (!downloaded) return `[${label}]`;

  // 默认不转写:当前所有 input_audio 供应商在本环境都不可用,发出去必 400/超时,
  // 白白吃满 timeout + 双 backup 重试 + 刷日志。开关关 → 直接中性占位,不发调用。
  // (旧实现把 audio/ogg 当 image 丢给 GPT vision,每条语音都注定失败 —— 已根治。)
  if (!env().AUDIO_TRANSCRIBE_ENABLED) return `[${label}]`;

  try {
    const base64 = Buffer.from(downloaded.buffer).toString('base64');
    const format = audioFormatFromMime(downloaded.mimeType);

    const result = await callWithFallback({
      usage: 'audio',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'audio', audio: base64, format },
            { type: 'text', text: '请转录并简要描述这段音频的内容。如果是语音消息，直接转录文字；如果是音乐或其他音频，描述内容。用中文回答，简洁。' },
          ],
        },
      ],
      maxTokens: 300,
    });

    return `[${label}内容：${result.content.trim()}]`;
  } catch (err) {
    logger.warn({ fileId, err }, 'Audio description failed');
    // 失败也用中性占位,别写"无法识别"——以免把别人的语音误读成 bot 出错。
    return `[${label}]`;
  }
}

async function describeDocument(
  fileId: string,
  mimeType: string | undefined,
  fileName: string | undefined,
): Promise<string> {
  const downloaded = await downloadTelegramFile(fileId);
  if (!downloaded) return '[文档]'; // 下不动≠不存在;中性占位,别误导成失败

  const effectiveMime = mimeType ?? downloaded.mimeType;

  // PDF — gemini can handle PDFs as base64 image-like inline
  if (effectiveMime === 'application/pdf') {
    // 当前 vision 路由实际落到 GPT,读不了 PDF base64 → 这通调用必败(与语音同类)。
    // 默认跳过,不烧 30s timeout + backup;接上 PDF-capable vision 后置 PDF_VISION_ENABLED=true。
    if (!env().PDF_VISION_ENABLED) {
      return `[PDF文档${fileName ? `「${fileName}」` : ''}]`;
    }
    try {
      const base64 = Buffer.from(downloaded.buffer).toString('base64');
      const dataUrl = `data:application/pdf;base64,${base64}`;

      const result = await callWithFallback({
        usage: 'vision',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', image: dataUrl },
              { type: 'text', text: '请简要描述这份PDF文档的主要内容（3-5句话）。用中文回答。' },
            ],
          },
        ],
        maxTokens: 400,
      });

      return `[PDF文档${fileName ? `「${fileName}」` : ''}内容：${result.content.trim()}]`;
    } catch (err) {
      logger.warn({ fileId, err }, 'PDF description failed');
      return `[PDF文档${fileName ? `「${fileName}」` : ''}：无法识别]`;
    }
  }

  // DOCX — extract text from XML
  if (
    effectiveMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName?.endsWith('.docx')
  ) {
    try {
      const text = extractDocxText(downloaded.buffer);
      if (text && text.length > 10) {
        const truncated = text.slice(0, 2000);
        // Summarize with AI
        const result = await callWithFallback({
          usage: 'summarize',
          messages: [
            {
              role: 'system',
              content: '用中文简要概括以下文档内容（3-5句话）。',
            },
            { role: 'user', content: truncated },
          ],
          maxTokens: 200,
          temperature: 0.3,
        });
        return `[Word文档${fileName ? `「${fileName}」` : ''}内容：${result.content.trim()}]`;
      }
    } catch (err) {
      logger.warn({ fileId, err }, 'DOCX description failed');
    }
    return `[Word文档${fileName ? `「${fileName}」` : ''}：无法读取内容]`;
  }

  // XLSX — extract text from shared strings XML inside the ZIP
  if (
    effectiveMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    fileName?.endsWith('.xlsx')
  ) {
    try {
      const text = extractXlsxText(downloaded.buffer);
      if (text && text.length > 10) {
        const truncated = text.slice(0, 2000);
        const result = await callWithFallback({
          usage: 'summarize',
          messages: [
            { role: 'system', content: '用中文简要概括以下Excel表格内容（3-5句话）。' },
            { role: 'user', content: truncated },
          ],
          maxTokens: 200,
          temperature: 0.3,
        });
        return `[Excel文件${fileName ? `「${fileName}」` : ''}内容：${result.content.trim()}]`;
      }
    } catch (err) {
      logger.warn({ fileId, err }, 'XLSX extraction failed');
    }
    return `[Excel文件${fileName ? `「${fileName}」` : ''}：无法读取内容]`;
  }

  // Plain text
  if (effectiveMime.startsWith('text/')) {
    try {
      const text = Buffer.from(downloaded.buffer).toString('utf-8').slice(0, 2000);
      return `[文本文件${fileName ? `「${fileName}」` : ''}内容：${text.replace(/\s+/g, ' ').trim()}]`;
    } catch {
      // ignore
    }
  }

  return `[文件${fileName ? `「${fileName}」` : ''}：类型 ${effectiveMime}，无法解析内容]`;
}

function extractDocxText(buffer: ArrayBuffer): string {
  // DOCX is a ZIP file — look for word/document.xml and extract w:t text nodes
  try {
    const bytes = Buffer.from(buffer);
    // Simple approach: search for XML content directly in the buffer
    const str = bytes.toString('binary');

    // Find word/document.xml content between ZIP local file entries
    // This is a simplified extraction without a full ZIP parser
    const startMarker = 'word/document.xml';
    const startIdx = str.indexOf(startMarker);
    if (startIdx < 0) return '';

    // Find the actual XML content after the local file header
    const xmlStart = str.indexOf('<?xml', startIdx);
    if (xmlStart < 0) return '';

    const xmlContent = str.slice(xmlStart, xmlStart + 100_000);

    // Extract text from w:t tags
    const textMatches = xmlContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [];
    return textMatches
      .map((m) => {
        const match = m.match(/<w:t[^>]*>([^<]*)<\/w:t>/);
        return match?.[1] ?? '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function extractXlsxText(buffer: ArrayBuffer): string {
  try {
    const bytes = Buffer.from(buffer);
    const str = bytes.toString('binary');
    // Find xl/sharedStrings.xml in the ZIP
    const marker = 'xl/sharedStrings.xml';
    const idx = str.indexOf(marker);
    if (idx < 0) return '';
    const xmlStart = str.indexOf('<?xml', idx);
    if (xmlStart < 0) return '';
    const xmlEnd = str.indexOf('</sst>', xmlStart);
    if (xmlEnd < 0) return '';
    const xml = str.slice(xmlStart, xmlEnd + 6);
    // Extract <t> text nodes
    const texts: string[] = [];
    const re = /<t[^>]*>([^<]+)<\/t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      texts.push(m[1]!);
    }
    return texts.join(' | ').slice(0, 3000).trim();
  } catch {
    return '';
  }
}

/**
/**
 * Telegram 文件路径 → 视频 MIME。
 *
 * downloadTelegramFile 从 HTTP 响应头取 content-type，而 Telegram 的 file 端点
 * 经常回 `application/octet-stream`（不猜类型）。视频理解按 MIME 分派，
 * 拿到 octet-stream 就废了——所以这里按扩展名兜一道。
 */
function videoMimeFromPath(filePath: string, fallback: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const byExt: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    '3gp': 'video/3gpp',
    ogv: 'video/ogg',
  };
  if (byExt[ext]) return byExt[ext];
  if (fallback.startsWith('video/')) return fallback;
  return 'video/mp4'; // Telegram 视频事实上的默认容器
}

/**
 * 描述一段视频。
 *
 * 2026-09-21：这里原来只有一行 `[视频：用户发送了一段视频]` + 一句
 * "description not supported yet"。那个判断**曾经是对的，现在过期了**——
 * 实测 step-5-preview（1M context）吃 base64 video_url，6 秒测试视频
 * 准确描述了内容（彩色条纹/彩虹斜线/移动方块/左上角计时器）。
 *
 * 三个必须注意的实际约束（都实测过）：
 *   ① **只有部分供应商支持视频**。同一个 video_url part 发给 dsv4flash
 *      （vision 链主选）连不上（那个端口整个是死的，见下），发给 step-3.7-flash
 *      返回 200 但 content 为空——它把全部 token 烧在 reasoning 上，
 *      finish_reason=length。所以视频走**独立的 video usage**，不蹭 vision 链。
 *   ② **max_tokens 必须给够**：reasoning 计入 completion，给 400 会得到空正文。
 *   ③ **时长有硬上限**（模型侧 5 分钟）。Telegram 侧还有更紧的一条：
 *      bot 下载上限 20MB、代码里 MAX_MEDIA_BYTES=10MB——5 分钟视频几乎必然超。
 *      所以现实里能描述的是"短视频"，超限的给中性占位并说明时长，
 *      不写"无法识别"（那会让 bot 以为是自己出错）。
 *
 * ⚠️ 不使用 Telegram file URL 直喂供应商：那个 URL 形如
 * `https://api.telegram.org/file/bot<TOKEN>/<path>`，把 bot token 交给第三方。
 * 必须 base64 内联，宁可付 1.33 倍体积。
 */
async function describeVideo(
  fileId: string,
  durationSec: number | undefined,
  label: string,
): Promise<string> {
  const maxSec = env().VIDEO_MAX_DURATION_SEC;
  // 时长已知且超限 → 不下白下载（Telegram 侧下载 + base64 都要花钱）。
  if (durationSec !== undefined && durationSec > maxSec) {
    logger.debug({ fileId, durationSec, maxSec }, 'Video too long for description');
    return `[${label}（${durationSec} 秒，超过 ${maxSec} 秒不上传）]`;
  }

  const downloaded = await downloadTelegramFile(fileId);
  // 下不动（多半太大）≠ 内容不存在。中性占位，别误导成失败。
  if (!downloaded) return `[${label}${durationSec ? `（${durationSec} 秒）` : ''}]`;

  if (!env().VIDEO_DESCRIBE_ENABLED) return `[${label}${durationSec ? `（${durationSec} 秒）` : ''}]`;

  try {
    const base64 = Buffer.from(downloaded.buffer).toString('base64');
    const mimeType = videoMimeFromPath(downloaded.filePath, downloaded.mimeType);

    const result = await callWithFallback({
      usage: 'video',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请描述这段视频的内容：画面里有什么、在发生什么、有没有文字或语音。3 句以内，用中文，口语化。' },
            { type: 'video_url', video_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
      // reasoning 计入 completion：给小了会拿到空正文（实测 step-3.7-flash
      // max_tokens=400 → content 为空、finish_reason=length）。
      maxTokens: env().VIDEO_DESCRIBE_MAX_TOKENS,
      // maxTimeoutMs 会钳住每一次尝试（含 backup），不是共享一个 signal——
      // 视频慢（base64 上传 + reasoning），默认 usage timeout 可能不够。
      maxTimeoutMs: env().VIDEO_DESCRIBE_TIMEOUT_MS,
    });

    const text = result.content.trim();
    if (!text) return `[${label}${durationSec ? `（${durationSec} 秒）` : ''}]`;
    return `[${label}内容：${text}]`;
  } catch (err) {
    logger.warn({ fileId, err }, 'Video description failed');
    // 失败同样用中性占位——别把群友发的视频误读成 bot 出了故障。
    return `[${label}${durationSec ? `（${durationSec} 秒）` : ''}]`;
  }
}

/**
 * Describe any multimodal content in a message (audio, voice, document, video).
 * Returns a descriptive string to inject into context, or null if none.
 */
export async function describeMultimodal(formatted: FormattedMessage): Promise<string | null> {
  const parts: string[] = [];

  // Voice message (highest priority — user is speaking)
  if (formatted.voiceFileId) {
    const desc = await describeAudio(formatted.voiceFileId, '语音消息');
    parts.push(desc);
  } else if (formatted.audioFileId) {
    const desc = await describeAudio(formatted.audioFileId, '音频');
    parts.push(desc);
  }

  // Document
  if (formatted.documentFileId) {
    const desc = await describeDocument(
      formatted.documentFileId,
      formatted.documentMimeType,
      formatted.documentFileName,
    );
    parts.push(desc);
  }

  // Video — 2026-09-21 接上真描述（step-5-preview 支持 base64 video_url）
  if (formatted.videoFileId || formatted.videoNoteFileId) {
    const fileId = formatted.videoFileId ?? formatted.videoNoteFileId!;
    const label = formatted.videoNoteFileId ? '圆形视频' : '视频';
    parts.push(await describeVideo(fileId, formatted.videoDurationSec, label));
  }

  if (parts.length === 0) return null;
  return parts.join('\n');
}
