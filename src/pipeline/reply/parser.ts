// ────────────────────────────────────────
// Reply 解析器 — JSON / XML / 纯文本 fallback
// ────────────────────────────────────────

import { z } from 'zod';
import { logger } from '../../shared/logger.js';
import { ALLOWED_INTENTS } from '../../knowledge/sticker/types.js';
import type { StickerIntent } from '../../knowledge/sticker/types.js';
import { normalizeReactionEmoji } from './reaction-emoji.js';

const STICKER_INTENTS = new Set<StickerIntent>(ALLOWED_INTENTS);

/**
 * True for content that's never worth sending: empty / whitespace / 纯省略号或点号
 * (空响应兜底的 '…' 占位、模型直接吐 "..."/"。。。" 等)。各发送点都用它兜底,避免把 '…' 发出去。
 */
export function isBlankReply(text: string | undefined | null): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;
  return /^[.。．·•…‥\s]+$/.test(t);
}

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
  /** True if this segment was inserted by the humanizer as a filler (e.g. "我想想") — skip typo/afterthought/delete-resend */
  isInterjection?: boolean;
  /**
   * G2 统一动作空间(TURN_ACTION_PLANNER_ENABLED):
   *   reply(默认/缺省)| react(只点 emoji)| sticker(只发贴纸)| silent(主动沉默)
   */
  action?: 'reply' | 'react' | 'sticker' | 'silent';
  /** action='react' 时的 emoji(已规范化到 Telegram 白名单) */
  emoji?: string;
  /** action='sticker':模型把贴纸当一等动作 → 投递层跳过贴纸冷却 */
  modelStickerAct?: boolean;
  /** G10: 模型表达的投递意图 — 这句想停顿酝酿一拍再发(重点/转折处) */
  hesitateBefore?: boolean;
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

  // Validate each item.
  // 文本回复保持 all-or-nothing(任一坏 → 整组拒收,走兜底);
  // 动作元素(react/sticker/silent)失败只丢该元素,不拖垮整组——
  // 否则一个非法 emoji 会让用户看到整段原始 JSON。
  const results: ParsedReply[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;
    const validated = validateAndReturn(record, fallbackMessageId);
    if (!validated) {
      const isActionItem = typeof record['action'] === 'string'
        && record['action'].toLowerCase() !== 'reply';
      if (isActionItem) {
        logger.debug({ action: record['action'] }, 'Dropping malformed action item');
        continue;
      }
      return null; // malformed TEXT reply → reject entire array
    }
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

  // 2.5 Try extracting JSON object from text (e.g. "json\n{...}" or "Response:\n{...}")
  const jsonExtractMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonExtractMatch) {
    const extracted = tryJsonParse(jsonExtractMatch[0]);
    if (extracted && !Array.isArray(extracted)) {
      const validated = validateAndReturn(extracted, fallbackMessageId);
      if (validated) return validated;
    }
  }

  // 3. Try XML parse
  const xmlResult = tryXmlParse(trimmed);
  if (xmlResult) {
    const validated = validateAndReturn(xmlResult, fallbackMessageId);
    if (validated) return validated;
  }

  // 3.5 Salvage — the model attempted JSON but it didn't fully parse (truncated /
  // broken). Extract the replyContent string so the user never sees raw/broken JSON.
  const salvaged = salvageReplyContent(trimmed);
  if (salvaged) {
    logger.debug('Salvaged replyContent from malformed JSON');
    return truncateReply({ replyContent: salvaged, targetMessageId: fallbackMessageId });
  }

  // 3.8 A lone action item that failed validation (e.g. bad emoji) must not
  // leak raw JSON to the user — degrade to deliberate silence.
  if (/"action"\s*:\s*"(react|sticker|silent)"/i.test(trimmed)) {
    logger.debug('Malformed lone action item, degrading to silent');
    return { action: 'silent', replyContent: '', targetMessageId: fallbackMessageId };
  }

  // 3.9 Schema 反刍安全网:模型把输出契约的 JSON Schema 原样吐了回来
  // (stepfun 偶发 —— prompt 里贴了完整 schema,模型有时复制它而非产出实例)。
  // 绝不把 schema 当纯文本发给用户 → 降级沉默 + warn 留痕。
  if (looksLikeReplySchema(trimmed)) {
    logger.warn({ rawHead: trimmed.slice(0, 120) }, 'AI regurgitated the reply schema — degrading to silent');
    return { action: 'silent', replyContent: '', targetMessageId: fallbackMessageId };
  }

  // 4. Plain text fallback — treat entire response as reply content
  logger.debug('Using plain text fallback for AI response');
  return truncateReply({
    replyContent: normalizeWhitespace(trimmed),
    targetMessageId: fallbackMessageId,
  });
}

/** 检测模型是否把 reply-schema 的定义本身当成了输出(而非一个实例)。 */
function looksLikeReplySchema(s: string): boolean {
  // 真回复的 replyContent 是 string 值,不会出现 "$schema": / "title": / "oneOf" / "$defs" 这种 JSON 键
  if (!/"(?:\$schema|title)"\s*:\s*"/.test(s)) return false;
  return /"oneOf"|"properties"|"\$defs"/.test(s);
}

/**
 * Best-effort recovery of replyContent from JSON-looking text that failed to parse.
 * Returns the extracted string, or null if the text doesn't look like attempted JSON.
 */
function stripLeadingCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  // 允许缺 closing fence(maxTokens 截断在 value 中间时常见)
  return trimmed.replace(/^```(?:json)?\s*\n?/i, '').trim();
}

function unescapeSalvagedString(value: string, quote: '"' | "'"): string {
  if (quote === '"') {
    try { return JSON.parse(`"${value}"`) as string; } catch { return value; }
  }
  return value.replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

export function salvageReplyContent(raw: string): string | null {
  const s = stripLeadingCodeFence(raw);
  if (!/[{[]/.test(s) || !/reply_?[cC]ontent/.test(s)) return null;

  // 标准 JSON:双引号 key + 双引号 value(完整闭合)
  const dq = s.match(/"reply_?[cC]ontent"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (dq?.[1] !== undefined) {
    return unescapeSalvagedString(dq[1], '"');
  }
  // 模型偶发吐 Python 风格 dict:{'replyContent': '...'}(单引号,完整闭合)
  const sq = s.match(/['"]reply_?[cC]ontent['"]\s*:\s*'((?:[^'\\]|\\.)*)'/);
  if (sq?.[1] !== undefined) {
    return unescapeSalvagedString(sq[1], "'");
  }
  // maxTokens 截断在 value 中间 —— 引号开了但没关上(日志里 sleep/proactive 泄漏的主因)
  const openDq = s.match(/"reply_?[cC]ontent"\s*:\s*"((?:[^"\\]|\\.)*)$/);
  if (openDq?.[1] !== undefined && openDq[1].length >= 2) {
    return unescapeSalvagedString(openDq[1], '"');
  }
  const openSq = s.match(/['"]reply_?[cC]ontent['"]\s*:\s*'((?:[^'\\]|\\.)*)$/);
  if (openSq?.[1] !== undefined && openSq[1].length >= 2) {
    return unescapeSalvagedString(openSq[1], "'");
  }
  return null;
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
  // ── G2 action items (react / sticker / silent) ──
  const actionRaw = typeof data['action'] === 'string' ? data['action'].toLowerCase() : undefined;
  if (actionRaw === 'silent') {
    return { action: 'silent', replyContent: '', targetMessageId: fallbackMessageId };
  }
  if (actionRaw === 'react') {
    const emoji = normalizeReactionEmoji(data['emoji'] ?? data['reaction']);
    if (!emoji) {
      logger.debug({ emoji: data['emoji'] }, 'React action with non-allowed emoji, dropping');
      return null;
    }
    let target = data['targetMessageId'] ?? data['target_message_id'] ?? fallbackMessageId;
    if (typeof target === 'string') target = parseInt(target, 10);
    if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
      target = fallbackMessageId;
    }
    return { action: 'react', emoji, replyContent: '', targetMessageId: target as number };
  }
  if (actionRaw === 'sticker') {
    const intents = normalizeStickerIntent(data['stickerIntent'] ?? data['sticker_intent']);
    if (!intents) {
      logger.debug('Sticker action without valid intent, dropping');
      return null;
    }
    let target = data['targetMessageId'] ?? data['target_message_id'] ?? fallbackMessageId;
    if (typeof target === 'string') target = parseInt(target, 10);
    if (typeof target !== 'number' || !Number.isFinite(target)) target = fallbackMessageId;
    return {
      action: 'sticker',
      replyContent: '[sticker]',
      stickerIntent: intents,
      targetMessageId: target as number,
      replyQuote: false,
    };
  }

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
    if (data['hesitateBefore'] === true || data['hesitate_before'] === true) {
      result.hesitateBefore = true;
    }
    return result;
  }

  logger.debug({ errors: parsed.error.issues }, 'Zod validation failed for parsed data');
  return null;
}
