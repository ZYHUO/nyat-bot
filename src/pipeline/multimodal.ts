// ────────────────────────────────────────
// Multimodal Processor — describe audio, documents, video
// ────────────────────────────────────────

import { getBot } from '../bot/bot.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';

async function downloadTelegramFile(fileId: string): Promise<{ buffer: ArrayBuffer; mimeType: string } | null> {
  try {
    const bot = getBot();
    const file = await bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) return null;

    const token = bot.token;
    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const response = await fetch(fileUrl);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
    return { buffer, mimeType };
  } catch (err) {
    logger.warn({ fileId, err }, 'downloadTelegramFile failed');
    return null;
  }
}

async function describeAudio(fileId: string, label: string): Promise<string> {
  const downloaded = await downloadTelegramFile(fileId);
  if (!downloaded) return `[${label}：无法下载]`;

  try {
    const base64 = Buffer.from(downloaded.buffer).toString('base64');
    // Use ogg/m4a as voice, mp3/m4a as audio — treat as generic audio
    const mimeType = downloaded.mimeType.startsWith('audio/') ? downloaded.mimeType : 'audio/ogg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const result = await callWithFallback({
      usage: 'vision', // gemini supports audio via vision endpoint
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: dataUrl },
            { type: 'text', text: '请转录并简要描述这段音频的内容。如果是语音消息，直接转录文字；如果是音乐或其他音频，描述内容。用中文回答，简洁。' },
          ],
        },
      ],
      maxTokens: 300,
    });

    return `[${label}内容：${result.content.trim()}]`;
  } catch (err) {
    logger.warn({ fileId, err }, 'Audio description failed');
    return `[${label}：无法识别]`;
  }
}

async function describeDocument(
  fileId: string,
  mimeType: string | undefined,
  fileName: string | undefined,
): Promise<string> {
  const downloaded = await downloadTelegramFile(fileId);
  if (!downloaded) return '[文档：无法下载]';

  const effectiveMime = mimeType ?? downloaded.mimeType;

  // PDF — gemini can handle PDFs as base64 image-like inline
  if (effectiveMime === 'application/pdf') {
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

  // Video
  if (formatted.videoFileId || formatted.videoNoteFileId) {
    const fileId = formatted.videoFileId ?? formatted.videoNoteFileId!;
    const label = formatted.videoNoteFileId ? '圆形视频' : '视频';
    parts.push(`[${label}：用户发送了一段视频]`);
    logger.debug({ fileId }, 'Video received — description not supported yet');
  }

  if (parts.length === 0) return null;
  return parts.join('\n');
}
