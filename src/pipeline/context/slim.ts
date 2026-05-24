// ────────────────────────────────────────
// Slim context format for AI — saves ~70% tokens vs JSON
// ────────────────────────────────────────
// Format:
//   [MM-DD HH:mm #messageId] Name(@username): text →回复 Name(#replyId)「snippet」
//   ★[MM-DD HH:mm #messageId] Name(@username): current message (starred)
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';

function padTwo(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = padTwo(d.getMonth() + 1);
  const dd = padTwo(d.getDate());
  const hh = padTwo(d.getHours());
  const min = padTwo(d.getMinutes());
  return `${mm}-${dd} ${hh}:${min}`;
}

function formatNameTag(msg: FormattedMessage, botUid: number): string {
  const name = msg.fullName || msg.username || 'Unknown';

  if (msg.role === 'assistant' || msg.uid === botUid) {
    return `${name}(bot)`;
  }
  if (msg.isAnonymous) {
    const label = msg.anonymousType === 'channel' ? '频道' : '匿名管理员';
    return `${name}[${label}]`;
  }
  if (msg.isBot) {
    return msg.username ? `${name}[BOT](@${msg.username})` : `${name}[BOT]`;
  }
  return msg.username ? `${name}(@${msg.username})` : name;
}

function formatContent(msg: FormattedMessage): string {
  const parts: string[] = [];

  if (msg.sticker) {
    const stickerWithDesc = msg.sticker as { emoji?: string; description?: string };
    const stickerDesc = stickerWithDesc.description
      ? `[贴纸: ${stickerWithDesc.description}]`
      : `[贴纸]`;
    parts.push(stickerDesc);
  }

  if (msg.imageFileId || (msg.imageDescriptions && msg.imageDescriptions.length > 0)) {
    const desc = msg.imageDescriptions?.[0] ?? '';
    parts.push(desc ? `[图片: ${desc}]` : '[图片]');
  }

  const text = msg.textContent || msg.captionContent || '';
  if (text) {
    parts.push(text);
  }

  if (msg.isForwarded && msg.forwardFrom) {
    parts.push(`[转发自 ${msg.forwardFrom}]`);
  }

  return parts.join(' ') || '[空消息]';
}

function formatReplyTag(msg: FormattedMessage): string {
  if (!msg.replyTo) return '';
  // Increase snippet length to preserve more context for pronoun resolution
  const snippet = (msg.replyTo.textSnippet ?? '').slice(0, 60);
  return ` →回复 ${msg.replyTo.fullName ?? ''}(#${msg.replyTo.messageId})「${snippet}」`;
}

export function slimContextForAI(
  messages: FormattedMessage[],
  currentMessage: FormattedMessage,
  botUid: number,
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const isCurrent = msg.messageId === currentMessage.messageId && msg.uid === currentMessage.uid;
    const star = isCurrent ? '★' : '';
    const ts = formatTimestamp(msg.timestamp);
    const nameTag = formatNameTag(msg, botUid);
    const content = formatContent(msg);
    const replyTag = formatReplyTag(msg);

    lines.push(`${star}[${ts} #${msg.messageId}] ${nameTag}: ${content}${replyTag}`);
  }

  return lines.join('\n');
}

/**
 * Format a single message for token estimation (no "current message" star marker).
 * Used by incremental token budget calculations.
 */
export function slimSingleMessage(msg: FormattedMessage, botUid: number): string {
  const ts = formatTimestamp(msg.timestamp);
  const nameTag = formatNameTag(msg, botUid);
  const content = formatContent(msg);
  const replyTag = formatReplyTag(msg);
  return `[${ts} #${msg.messageId}] ${nameTag}: ${content}${replyTag}`;
}
