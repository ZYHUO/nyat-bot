import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';

const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

export type TelegramUser = z.infer<typeof telegramUserSchema>;

/**
 * Validate Telegram WebApp initData using HMAC-SHA256.
 * Returns the authenticated TelegramUser or null if validation fails.
 */
export function validateInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = createHmac('sha256', secret).update(dataCheckString).digest('hex');

    // Constant-time comparison to prevent timing attacks
    const computedBuf = Buffer.from(computed, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (computedBuf.length !== hashBuf.length || !timingSafeEqual(computedBuf, hashBuf)) return null;

    // Check auth_date freshness (24h window — Telegram's recommended production limit)
    const authDate = params.get('auth_date');
    if (!authDate) return null; // auth_date 必须存在
    const authTs = parseInt(authDate, 10);
    if (!Number.isFinite(authTs)) return null;
    const age = Math.floor(Date.now() / 1000) - authTs;
    if (age > 86400) return null;

    // Parse and validate user
    const userJson = params.get('user');
    if (!userJson) return null;
    const parsed = telegramUserSchema.safeParse(JSON.parse(userJson));
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'validateInitData: user payload schema invalid');
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn({ err }, 'validateInitData failed');
    return null;
  }
}

export function isMaster(userId: number, masterUid: number): boolean {
  const extra = new Set(env().MASTER_UID_EXTRA);
  return (masterUid > 0 && userId === masterUid) || extra.has(userId);
}
