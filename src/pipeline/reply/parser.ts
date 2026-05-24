// ────────────────────────────────────────
// Reply 解析器 — JSON / XML / 纯文本 fallback
// ────────────────────────────────────────

import { z } from 'zod';
import { logger } from '../../shared/logger.js';
import { ALLOWED_INTENTS } from '../../knowledge/sticker/types.js';
import type { StickerIntent } from '../../knowledge/sticker/types.js';

const STICKER_INTENTS = new Set<StickerIntent>(ALLOWED_INTENTS);

/** Normalize stickerIntent: accept string or string[], return string[] | undefined */
function normalizeStickerIntent(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  const valid = arr
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v): v is StickerIntent => STICKER_INTENTS.has(v as StickerIntent))
    .slice(0, 3);
  return valid.length > 0 ? valid : undefined;
}

const replyOutputSchema = z.object({
  replyContent: z.string().min(1),
  targetMessageId: z.number().int(),
  stickerIntent: z.union([z.string(), z.array(z.string())]).optional(),
});

export interface ParsedReply {
  replyContent: string;
  targetMessageId: number;
  stickerIntent?: string[];
  handoffToSplitter?: boolean;
  replyQuote?: boolean;
}

/**
 * Normalize escaped whitespace characters in a string.
 * Matches PHP ReplyXmlPackage::parse() behavior.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\n');
}

/**
 * Strip residual CDATA markers that may remain after extraction.
 */
function stripResidualCdata(text: string): string {
  return text
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/\]>/g, '');
}

/**
 * Fix unescaped quotes inside replyContent/reply_content/content field values.
 * AI sometimes outputs: "replyContent": "text with "quotes" inside"
 * which breaks JSON parsing.
 */
function fixUnescapedQuotesInContent(jsonStr: string): string {
  // Match content field start
  const match = jsonStr.match(/"(replyContent|reply_content|content)"\s*:\s*"/);
  if (!match || match.index === undefined) return jsonStr;

  const startIdx = match.index + match[0].length;
  let endIdx = startIdx;
  let escaped = false;

  // Find the real closing quote by looking for " followed by , or }
  for (let i = startIdx; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (char === '"' && !escaped) {
      // Check if next non-whitespace char is , or }
      const next = jsonStr.slice(i + 1).match(/^\s*([,}])/);
      if (next) {
        endIdx = i;
        break;
      }
    }

    escaped = (char === '\\' && !escaped);
  }

  if (endIdx === startIdx) return jsonStr;

  // Extract the value and escape internal quotes
  const value = jsonStr.substring(startIdx, endIdx);
  const fixedValue = value.replace(/(?<!\\)"/g, '\\"');

  return jsonStr.substring(0, startIdx) + fixedValue + jsonStr.substring(endIdx);
}

/**
 * Try to parse raw AI response as JSON.
 * Includes pre-processing to fix common AI output issues.
 */
function tryJsonParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Try to fix unescaped quotes in content fields
    const fixed = fixUnescapedQuotesInContent(raw);
    if (fixed !== raw) {
      try {
        return JSON.parse(fixed) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Try to extract JSON from markdown code blocks.
 */
function tryCodeBlockJson(raw: string): Record<string, unknown> | null {
  const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (!match?.[1]) return null;
  return tryJsonParse(match[1].trim());
}

/**
 * Extract content from XML tag, handling:
 * - Standard CDATA: <![CDATA[content]]>
 * - Malformed CDATA: <![CDATA[content]> (missing bracket)
 * - No CDATA: plain text in tags
 */
function extractXmlTagContent(xml: string, tagName: string): string | null {
  // Try standard CDATA first
  const cdataRe = new RegExp(`<${tagName}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch?.[1] !== undefined) return cdataMatch[1];

  // Try malformed CDATA (missing closing bracket)
  const malformedRe = new RegExp(`<${tagName}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]>\\s*</${tagName}>`, 'i');
  const malformedMatch = xml.match(malformedRe);
  if (malformedMatch?.[1] !== undefined) return malformedMatch[1];

  // Try plain text (no CDATA)
  const plainRe = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, 'i');
  const plainMatch = xml.match(plainRe);
  if (plainMatch?.[1] !== undefined) return plainMatch[1];

  return null;
}

/**
 * Try to parse XML response format.
 * Matches PHP ReplyXmlPackage::parse() behavior.
 */
function tryXmlParse(raw: string): Record<string, unknown> | null {
  // Strip code fences (``` or ```xml) like PHP does
  let s = raw;
  const fenceMatch = s.match(/^```(?:xml)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  if (fenceMatch?.[1]) {
    s = fenceMatch[1].trim();
  }

  // Must contain <response> or <reply_content>
  if (!s.includes('<response') && !s.includes('<reply_content')) return null;

  const replyContent = extractXmlTagContent(s, 'reply_content');
  if (replyContent === null) return null;

  const cleaned = stripResidualCdata(normalizeWhitespace(replyContent));

  const targetRaw = extractXmlTagContent(s, 'target_message_id');
  const targetMessageId = targetRaw ? parseInt(targetRaw.trim(), 10) : 0;

  const stickerRaw = extractXmlTagContent(s, 'sticker_intent');
  const stickerIntent = stickerRaw?.trim() || undefined;

  const result: Record<string, unknown> = {
    replyContent: cleaned,
    targetMessageId: isNaN(targetMessageId) ? 0 : targetMessageId,
  };

  if (stickerIntent) {
    result['stickerIntent'] = stickerIntent;
  }

  return result;
}

const MAX_MULTI_REPLIES = 5;

/**
 * Try to parse raw string as a JSON array of reply objects.
 */
function tryArrayParse(raw: string, fallbackMessageId: number): ParsedReply[] | null {
  let arr: unknown = null;

  // Direct JSON array
  try { arr = JSON.parse(raw); } catch { /* ignore */ }

  // Try code block
  if (!Array.isArray(arr)) {
    const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
    if (match?.[1]) {
      try { arr = JSON.parse(match[1].trim()); } catch { /* ignore */ }
    }
  }

  if (!Array.isArray(arr) || arr.length === 0) return null;

  // Validate each item
  const results: ParsedReply[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) return null;
    const validated = validateAndReturn(item as Record<string, unknown>, fallbackMessageId);
    if (!validated) return null; // If ANY item fails, reject entire array
    results.push(validated);
  }

  return results.length > 0 && results.length <= MAX_MULTI_REPLIES ? results : null;
}

/**
 * Parse single reply from AI response (existing logic).
 */
function parseSingleReply(trimmed: string, fallbackMessageId: number): ParsedReply {
  // 1. Try direct JSON parse (object only)
  const json = tryJsonParse(trimmed);
  if (json && !Array.isArray(json)) {
    const validated = validateAndReturn(json, fallbackMessageId);
    if (validated) return validated;
  }

  // 2. Try JSON in markdown code block
  const codeBlockJson = tryCodeBlockJson(trimmed);
  if (codeBlockJson) {
    const validated = validateAndReturn(codeBlockJson, fallbackMessageId);
    if (validated) return validated;
  }

  // 3. Try XML parse
  const xmlResult = tryXmlParse(trimmed);
  if (xmlResult) {
    const validated = validateAndReturn(xmlResult, fallbackMessageId);
    if (validated) return validated;
  }

  // 4. Plain text fallback — treat entire response as reply content
  logger.debug('Using plain text fallback for AI response');
  return truncateReply({
    replyContent: normalizeWhitespace(trimmed),
    targetMessageId: fallbackMessageId,
  });
}

/**
 * Parse AI response into array of ReplyOutput.
 * Supports both single object and array of objects.
 *
 * Parse order:
 * 1. JSON array (multi-reply)
 * 2. Direct JSON object
 * 3. JSON in markdown code block
 * 4. XML with CDATA (PHP compatibility)
 * 5. Plain text fallback
 *
 * Always returns an array (single reply is wrapped in [reply]).
 */
export function parseReplyResponse(raw: string, fallbackMessageId: number): ParsedReply[] {
  const trimmed = raw.trim();

  if (!trimmed) {
    logger.warn('Empty AI response, using fallback');
    return [{ replyContent: '…', targetMessageId: fallbackMessageId }];
  }

  // 1. Try array parse first (multi-reply)
  const arrayResult = tryArrayParse(trimmed, fallbackMessageId);
  if (arrayResult) {
    logger.debug({ count: arrayResult.length }, 'Parsed multi-reply array');
    return arrayResult;
  }

  // 2. Fall back to single reply (wrapped in array)
  return [parseSingleReply(trimmed, fallbackMessageId)];
}

/** Truncate replyContent to Telegram's 4096-char limit */
function truncateReply(reply: ParsedReply): ParsedReply {
  if (reply.replyContent.length > 4096) {
    reply.replyContent = reply.replyContent.slice(0, 4093) + '...';
  }
  return reply;
}

function validateAndReturn(
  data: Record<string, unknown>,
  fallbackMessageId: number,
): ParsedReply | null {
  // Normalize field names (handle camelCase and snake_case)
  const normalized: Record<string, unknown> = {
    replyContent: data['replyContent'] ?? data['reply_content'] ?? data['content'],
    targetMessageId: data['targetMessageId'] ?? data['target_message_id'] ?? fallbackMessageId,
    stickerIntent: normalizeStickerIntent(data['stickerIntent'] ?? data['sticker_intent']),
  };

  // Ensure targetMessageId is a number
  if (typeof normalized['targetMessageId'] === 'string') {
    normalized['targetMessageId'] = parseInt(normalized['targetMessageId'] as string, 10);
  }
  if (!normalized['targetMessageId'] || isNaN(normalized['targetMessageId'] as number)) {
    normalized['targetMessageId'] = fallbackMessageId;
  }

  const parsed = replyOutputSchema.safeParse(normalized);
  if (parsed.success) {
    const { stickerIntent, ...rest } = parsed.data;
    const result: ParsedReply = truncateReply({
      ...rest,
      stickerIntent: stickerIntent
        ? (Array.isArray(stickerIntent) ? stickerIntent : [stickerIntent])
        : undefined,
    });
    if (data['handoffToSplitter'] === true) {
      result.handoffToSplitter = true;
    }
    if (data['replyQuote'] === false) {
      result.replyQuote = false;
    }
    return result;
  }

  logger.debug({ errors: parsed.error.issues }, 'Zod validation failed for parsed data');
  return null;
}
