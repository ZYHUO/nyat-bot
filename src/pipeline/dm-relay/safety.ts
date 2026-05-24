// ────────────────────────────────────────
// Safety Pipeline — ban/rate/membership/spam/dedup checks
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { getRedis } from '../../db/redis.js';
import { getBot } from '../../bot/bot.js';
import { callWithFallback } from '../../ai/fallback.js';
import { logger } from '../../shared/logger.js';

const SPAM_COUNTER_PREFIX = 'xxb:relay:spam:';
const SPAM_COUNTER_TTL = 30 * 86400; // 30 days
const SPAM_BAN_THRESHOLD = 5;
const MEMBERSHIP_CACHE_PREFIX = 'xxb:relay:member:';
const MEMBERSHIP_CACHE_TTL = 300; // 5 min
const DEDUP_WINDOW_SEC = 3600; // 1 hour

export type SafetyResult =
  | { ok: true }
  | { ok: false; reason: string; reply: string };

/** Check if user is banned from relay */
function isBanned(uid: number): boolean {
  const row = getDb().prepare(
    'SELECT uid FROM relay_bans WHERE uid = ?',
  ).get(uid);
  return !!row;
}

/** Record ban in SQLite */
function recordBan(uid: number, reason: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'INSERT OR IGNORE INTO relay_bans (uid, reason, banned_at) VALUES (?, ?, ?)',
  ).run(uid, reason, now);
}

/** Check if sender is a member of the target group (cached) */
async function verifyMembership(groupChatId: number, senderUid: number): Promise<boolean> {
  const redis = getRedis();
  const cacheKey = `${MEMBERSHIP_CACHE_PREFIX}${groupChatId}:${senderUid}`;

  const cached = await redis.get(cacheKey);
  if (cached === '1') return true;
  if (cached === '0') return false;

  try {
    const member = await getBot().api.getChatMember(groupChatId, senderUid);
    const isMember = ['member', 'administrator', 'creator', 'restricted'].includes(member.status);
    await redis.set(cacheKey, isMember ? '1' : '0', 'EX', MEMBERSHIP_CACHE_TTL);
    return isMember;
  } catch (err) {
    logger.warn({ err, groupChatId, senderUid }, 'getChatMember failed');
    return false;
  }
}

/** AI spam check — returns true if message is spam/ad */
async function checkSpam(content: string, senderUid: number): Promise<boolean> {
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: '判断以下用户私聊转发的消息是否是广告/spam/推广/诈骗/引流。仅输出JSON: {"is_spam": true/false, "confidence": 0.0-1.0}',
        },
        { role: 'user', content },
      ],
      maxTokens: 50,
      temperature: 0,
    });

    try {
      const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned) as { is_spam?: boolean; confidence?: number };
      if (parsed.is_spam && (parsed.confidence ?? 0) >= 0.7) {
        // Increment spam counter
        const redis = getRedis();
        const key = SPAM_COUNTER_PREFIX + senderUid;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, SPAM_COUNTER_TTL);

        if (count >= SPAM_BAN_THRESHOLD) {
          recordBan(senderUid, 'auto: spam threshold reached');
          logger.warn({ senderUid, count }, 'User banned from relay: spam threshold');
        }
        return true;
      }
    } catch {
      // Parse failed, treat as not spam
    }
  } catch (err) {
    logger.warn({ err }, 'Spam check AI call failed, allowing message');
  }
  return false;
}

/** Normalize text for dedup comparison */
function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Check if a similar message was recently sent to same target */
function isDuplicate(targetUid: number, groupChatId: number, content: string): boolean {
  const cutoff = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_SEC;
  const rows = getDb().prepare(`
    SELECT content FROM relay_log
    WHERE target_uid = ? AND group_chat_id = ? AND created_at > ?
    ORDER BY created_at DESC LIMIT 10
  `).all(targetUid, groupChatId, cutoff) as Array<{ content: string }>;

  const normalized = normalizeForDedup(content);
  return rows.some((r) => normalizeForDedup(r.content) === normalized);
}

/** Run full safety pipeline. Short-circuits on first failure. */
export async function runSafetyChecks(
  senderUid: number,
  groupChatId: number,
  targetUid: number,
  content: string,
): Promise<SafetyResult> {
  // 1. Ban check (sync, <1ms)
  if (isBanned(senderUid)) {
    return { ok: false, reason: 'banned', reply: '你的转发功能已被禁用喵~' };
  }

  // 2. Membership verification (Telegram API, ~100ms)
  const isMember = await verifyMembership(groupChatId, senderUid);
  if (!isMember) {
    return { ok: false, reason: 'not_member', reply: '你不在这个群里喵，不能转发消息~' };
  }

  // 3. Ad/spam AI check (~200ms)
  const isSpam = await checkSpam(content, senderUid);
  if (isSpam) {
    return { ok: false, reason: 'spam', reply: '这条消息被判定为广告/spam，无法转发喵~' };
  }

  // 4. Dedup check (sync, <5ms)
  if (isDuplicate(targetUid, groupChatId, content)) {
    return { ok: false, reason: 'duplicate', reply: '最近已经有人发过类似的消息给 TA 了喵~' };
  }

  return { ok: true };
}
