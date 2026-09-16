// ────────────────────────────────────────
// StickerFeedback — pick stickers based on AI sticker_intent
// Port of PHP StickerFeedback class
// ────────────────────────────────────────

import { getReadyStickersByIntent } from './store.js';
import { logger } from '../../shared/logger.js';
import { ALLOWED_INTENTS } from './types.js';
import type { StickerIntent } from './types.js';

export interface StickerFeedbackConfig {
  enabled: boolean;
  mode: 'off' | 'ai' | 'sticker_only';
  maxReplyChars: number;
  sendPosition: 'before' | 'after';
}

export function getStickerConfig(): StickerFeedbackConfig {
  return {
    enabled: process.env['STICKER_FEEDBACK_ENABLED'] === 'true' ||
             process.env['STICKER_FEEDBACK_ENABLED'] === '1',
    mode: (process.env['STICKER_FEEDBACK_MODE'] as StickerFeedbackConfig['mode']) ?? 'ai',
    maxReplyChars: parseInt(process.env['STICKER_MAX_REPLY_CHARS'] ?? '140', 10) || 140,
    sendPosition: (process.env['STICKER_SEND_POSITION'] as 'before' | 'after') ?? 'before',
  };
}

export function normalizeIntent(raw: string | undefined): StickerIntent | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim() as StickerIntent;
  return ALLOWED_INTENTS.includes(lower) ? lower : null;
}

export function shouldSend(
  config: StickerFeedbackConfig,
  action: string,
  replyText: string,
  replySource: string,
): boolean {
  if (!config.enabled || config.mode === 'off') return false;
  if (action !== 'REPLY') return false;
  if (replySource !== 'xml' && replySource !== 'json') return false;
  return replyText.trim() !== '' && replyText.length <= config.maxReplyChars;
}

export function shouldSendTextAfterSticker(
  config: StickerFeedbackConfig,
  stickerSent: boolean,
): boolean {
  if (!stickerSent) return true;
  return config.mode !== 'sticker_only';
}

export function pickFileId(intent: StickerIntent): string | null {
  try {
    const candidates = getReadyStickersByIntent(intent);
    if (candidates.length === 0) return null;
    return weightedRandom(candidates.slice(0, 10));
  } catch (err) {
    logger.warn({ err, intent }, 'pickFileId failed');
    return null;
  }
}

function weightedRandom(
  candidates: Array<{ fileId: string; score: number }>,
): string {
  candidates.sort((a, b) => b.score - a.score);
  const total = candidates.reduce((sum, c) => sum + Math.max(1, c.score), 0);
  let rand = Math.floor(Math.random() * total) + 1;
  for (const c of candidates) {
    rand -= Math.max(1, c.score);
    if (rand <= 0) return c.fileId;
  }
  return candidates[0]!.fileId;
}
