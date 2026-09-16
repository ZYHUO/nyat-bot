import { InlineKeyboard } from 'grammy';
import type { Challenge } from './challenge.js';

/**
 * Build an InlineKeyboard with answer options for a verification challenge.
 * callback_data format: "verify:answer:{chatId}:{answer}"
 * Max callback_data length is 64 bytes, so we keep it compact.
 */
export function buildChallengeKeyboard(
  challenge: Challenge,
  chatId: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let i = 0; i < challenge.options.length; i++) {
    const option = challenge.options[i]!;
    kb.text(option, `verify:a:${chatId}:${i}`);
    if (i < challenge.options.length - 1) {
      kb.row();
    }
  }

  return kb;
}

/**
 * Build admin action keyboard for a pending verification.
 */
export function buildAdminKeyboard(
  chatId: number,
  userId: number,
): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ 通过', `verify:admin_pass:${chatId}:${userId}`)
    .text('❌ 拒绝', `verify:admin_fail:${chatId}:${userId}`);
}

/**
 * Parse verify callback data.
 */
export function parseVerifyCallback(data: string): {
  action: string;
  chatId: number;
  value: string;
} | null {
  if (!data.startsWith('verify:')) return null;

  const parts = data.split(':');
  if (parts.length < 3) return null;

  return {
    action: parts[1]!,
    chatId: Number(parts[2]),
    value: parts.slice(3).join(':'),
  };
}
