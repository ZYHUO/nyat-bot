import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import type { FormattedMessage } from '../shared/types.js';
import { findConversationRef, getOrCreateConversationId, getOrCreateMessageId, getOrCreateUserId, isPlatformInternalId } from './identity-store.js';
import type { ConversationRef } from './types.js';
import { hasMemorySourceAuthority, retractMemorySources } from '../memory/source-store.js';

type GroupNoticeKind = 'group_increase' | 'group_decrease' | 'group_admin' | 'group_ban';
interface NoticeBase { accountId: string; timestampMs: number; userId: string; }
export type NormalizedOneBotNotice =
  | (NoticeBase & { kind: GroupNoticeKind; groupId: string; subType: string; operatorId?: string; durationSec?: number })
  | (NoticeBase & { kind: 'friend_add' })
  | (NoticeBase & { kind: 'group_recall' | 'friend_recall'; groupId?: string; messageId: string; operatorId?: string })
  | (NoticeBase & { kind: 'group_msg_emoji_like'; groupId: string; messageId: string; likes: Array<{ emojiId: string; count: number }> });

export class OneBotNoticeError extends Error {
  constructor(readonly code: string) { super(`OneBot notice: ${code}`); this.name = 'OneBotNoticeError'; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown, allowZero = false, signed = false): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !(signed ? /^-?(?:0|[1-9]\d*)$/ : allowZero ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? value : null;
}
function requiredId(value: unknown, allowZero = false, signed = false): string {
  const result = id(value, allowZero, signed);
  if (result === null) throw new OneBotNoticeError('invalid_notice_id');
  return result;
}

/** Unsupported notices remain explicit omissions, never invented chat messages. */
export function decodeOneBotNotice(raw: unknown, expectedAccountId: string): NormalizedOneBotNotice | null {
  const event = object(raw);
  if (!event || event['post_type'] !== 'notice') return null;
  if (requiredId(event['self_id']) !== expectedAccountId) throw new OneBotNoticeError('wrong_account');
  const kind = event['notice_type'];
  if (!['group_increase', 'group_decrease', 'group_admin', 'group_ban', 'friend_add',
    'group_recall', 'friend_recall', 'group_msg_emoji_like'].includes(String(kind))) return null;
  const time = event['time'];
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0 || !Number.isSafeInteger(time * 1000)) {
    throw new OneBotNoticeError('invalid_notice_time');
  }
  const userId = requiredId(event['user_id'], kind === 'group_ban');
  const base = { accountId: expectedAccountId, timestampMs: time * 1000, userId };
  if (kind === 'friend_add') return { ...base, kind };
  if (kind === 'friend_recall') return { ...base, kind, messageId: requiredId(event['message_id'], false, true) };
  const groupId = requiredId(event['group_id']);
  if (kind === 'group_msg_emoji_like') {
    const likes = event['likes'];
    if (!Array.isArray(likes) || likes.length > 16 || likes.length === 0) throw new OneBotNoticeError('invalid_reaction_notice');
    const normalized = likes.map(item => {
      const like = object(item);
      const emojiId = id(like?.['emoji_id'], true);
      const count = like?.['count'];
      if (!emojiId || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 10000) {
        throw new OneBotNoticeError('invalid_reaction_notice');
      }
      return { emojiId, count };
    }).sort((a, b) => a.emojiId.localeCompare(b.emojiId));
    return { ...base, kind, groupId, messageId: requiredId(event['message_id'], false, true), likes: normalized };
  }
  const operatorId = event['operator_id'] === undefined ? undefined : requiredId(event['operator_id'], true);
  if (kind === 'group_recall') return { ...base, kind, groupId, messageId: requiredId(event['message_id'], false, true), operatorId };
  const subType = event['sub_type'];
  const allowed: Record<GroupNoticeKind, string[]> = {
    group_increase: ['approve', 'invite'], group_decrease: ['leave', 'kick', 'kick_me'],
    group_admin: ['set', 'unset'], group_ban: ['ban', 'lift_ban'],
  };
  if (typeof subType !== 'string' || !allowed[kind as GroupNoticeKind].includes(subType)) throw new OneBotNoticeError('invalid_notice_subtype');
  if (kind === 'group_decrease' && subType === 'kick_me' && userId !== expectedAccountId) throw new OneBotNoticeError('invalid_kick_me');
  let durationSec: number | undefined;
  if (kind === 'group_ban') {
    const duration = event['duration'];
    if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 0 || duration > 31_536_000) {
      throw new OneBotNoticeError('invalid_ban_duration');
    }
    durationSec = duration;
  }
  return { ...base, kind: kind as GroupNoticeKind, groupId, subType, operatorId, durationSec };
}

function conversation(notice: NormalizedOneBotNotice): ConversationRef {
  return { platform: 'qq', idNamespace: 'qq-number', accountId: notice.accountId,
    conversationKind: 'groupId' in notice && notice.groupId ? 'group' : 'private',
    id: 'groupId' in notice && notice.groupId ? notice.groupId : notice.userId };
}
function allowlistAllows(raw: string, value: string): boolean {
  const values = raw.split(',').map(part => part.trim()).filter(Boolean);
  if (values.some(part => id(part) === null)) return false;
  return values.length === 0 || values.includes(value);
}

const APPLY_MEMBERSHIP = `
local score = tonumber(ARGV[1])
local previous = tonumber(redis.call('HGET', KEYS[3], ARGV[2]) or '0')
if previous > score then return 0 end
redis.call('HSET', KEYS[3], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[3], 2592000)
if ARGV[3] == '1' then
  redis.call('HSET', KEYS[1], ARGV[2], ARGV[4])
  redis.call('SADD', KEYS[2], ARGV[5])
  redis.call('EXPIRE', KEYS[1], 2592000)
  redis.call('EXPIRE', KEYS[2], 2592000)
else
  redis.call('HDEL', KEYS[1], ARGV[2])
  redis.call('SREM', KEYS[2], ARGV[5])
  if ARGV[6] == '1' then redis.call('ZREM', KEYS[4], ARGV[5]) end
end
return 1
`;

/** Metadata only. No welcome, auto-approval, moderation or model-generated action. */
export async function ingestOneBotNotice(notice: NormalizedOneBotNotice, context?: { signal: AbortSignal }): Promise<void> {
  const config = env();
  const now = Date.now();
  if (!config.ONEBOT_ENABLED || context?.signal.aborted || notice.accountId !== config.ONEBOT_ACCOUNT_ID ||
    !(config.META_ACTIVATED_AT_SEC > 0) || !Number.isSafeInteger(notice.timestampMs) ||
    notice.timestampMs < config.META_ACTIVATED_AT_SEC * 1000 || notice.timestampMs < now - 86_400_000 || notice.timestampMs > now + 300_000) return;
  const ref = conversation(notice);
  if (!allowlistAllows(ref.conversationKind === 'group' ? config.ONEBOT_ALLOWED_GROUP_IDS : config.ONEBOT_ALLOWED_USER_IDS, ref.id)) return;
  // No untrusted payload, names, verification text or URLs enter the stored receipt.
  const key = createHash('sha256').update(JSON.stringify(notice)).digest('hex');
  const chatId = getOrCreateConversationId(ref);
  const messageId = 'messageId' in notice ? getOrCreateMessageId({ conversation: ref, id: notice.messageId }) : null;
  const db = getDb();
  const previousSync = Number(db.pragma('synchronous', { simple: true }));
  if (db.inTransaction) throw new OneBotNoticeError('nested_transaction_refused');
  db.pragma('synchronous = FULL');
  try {
    db.transaction(() => {
      const inserted = db.prepare(`INSERT OR IGNORE INTO onebot_notice_receipts
        (event_key, account_id, kind, chat_id, user_id, message_id, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, notice.accountId, notice.kind, chatId, notice.userId, messageId, notice.timestampMs, now);
      if (inserted.changes !== 1) return false;
      if (notice.kind === 'friend_add') {
        db.prepare(`INSERT INTO onebot_friend_state (account_id, user_id, added_at) VALUES (?, ?, ?)
          ON CONFLICT(account_id, user_id) DO UPDATE SET added_at = MAX(added_at, excluded.added_at)`)
          .run(notice.accountId, notice.userId, notice.timestampMs);
      } else if (notice.kind === 'group_recall' || notice.kind === 'friend_recall') {
        db.prepare(`INSERT INTO onebot_message_recalls (chat_id, message_id, account_id, recalled_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(chat_id, message_id) DO UPDATE SET recalled_at = MAX(recalled_at, excluded.recalled_at)`)
          .run(chatId, messageId, notice.accountId, notice.timestampMs);
        if ((config.MEMORY_PROJECTION_OUTBOX_ENABLED === true || hasMemorySourceAuthority()) && messageId !== null) {
          retractMemorySources([`${chatId}_${messageId}`], now);
        }
      } else if ('subType' in notice) {
        db.prepare(`INSERT OR IGNORE INTO onebot_group_member_state (account_id, group_id, user_id) VALUES (?, ?, ?)`)
          .run(notice.accountId, notice.groupId, notice.userId);
        if (notice.kind === 'group_increase' || notice.kind === 'group_decrease') {
          const present = Number(notice.kind === 'group_increase');
          db.prepare(`UPDATE onebot_group_member_state SET present = ?, presence_at = ?
            WHERE account_id = ? AND group_id = ? AND user_id = ? AND (presence_at < ? OR (presence_at = ? AND present = 1 AND ? = 0))`)
            .run(present, notice.timestampMs, notice.accountId, notice.groupId, notice.userId, notice.timestampMs, notice.timestampMs, present);
        } else if (notice.kind === 'group_admin') {
          db.prepare(`UPDATE onebot_group_member_state SET role = ?, role_at = ?
            WHERE account_id = ? AND group_id = ? AND user_id = ? AND role_at < ?`)
            .run(notice.subType === 'set' ? 'admin' : 'member', notice.timestampMs, notice.accountId, notice.groupId, notice.userId, notice.timestampMs);
        } else if (notice.kind === 'group_ban') {
          // -1 is an observed whole-group/indefinite ban, not a guessed expiry.
          const until = notice.subType === 'lift_ban' ? 0 : notice.durationSec ? notice.timestampMs + notice.durationSec * 1000 : -1;
          db.prepare(`UPDATE onebot_group_member_state SET muted_until = ?, mute_at = ?
            WHERE account_id = ? AND group_id = ? AND user_id = ? AND mute_at < ?`)
            .run(until, notice.timestampMs, notice.accountId, notice.groupId, notice.userId, notice.timestampMs);
        }
      }
      db.prepare('DELETE FROM onebot_notice_receipts WHERE received_at < ?').run(now - 30 * 86_400_000);
      return true;
    }).immediate();
  } finally { db.pragma(`synchronous = ${previousSync}`); }
  if (context?.signal.aborted) return;

  if (notice.kind === 'group_increase' || notice.kind === 'group_decrease') {
    // Replayed metadata can repair a failed cache write, but cannot undo a newer departure.
    const current = db.prepare(`SELECT present, presence_at FROM onebot_group_member_state
      WHERE account_id = ? AND group_id = ? AND user_id = ?`).get(notice.accountId, notice.groupId, notice.userId) as
      { present: number; presence_at: number } | undefined;
    if (current?.presence_at !== notice.timestampMs || current.present !== Number(notice.kind === 'group_increase')) return;
    const redis = getRedis();
    const uid = getOrCreateUserId({ platform: 'qq', idNamespace: 'qq-number', accountId: notice.accountId, id: notice.userId });
    if (notice.kind === 'group_increase' && notice.userId === notice.accountId) return;
    const present = notice.kind === 'group_increase';
    await redis.eval(APPLY_MEMBERSHIP, 4, `xxb:members:${chatId}`, `xxb:user:groups:${uid}`,
      `xxb:onebot:members:clock:${chatId}`, 'xxb:active_groups',
      String(notice.timestampMs * 2 + Number(!present)), String(uid), String(Number(present)),
      JSON.stringify({ uid, username: '', fullName: `QQ ${notice.userId}`, lastSeen: Math.floor(notice.timestampMs / 1000) }),
      String(chatId), String(Number(notice.userId === notice.accountId)));
  }
}

/** Query the durable local recall record; this is not proof an unobserved message still exists. */
export function isOneBotMessageRecalled(chatId: number, messageId: number): boolean {
  if (!isPlatformInternalId(chatId)) return false;
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) throw new OneBotNoticeError('invalid_internal_id');
  return !!getDb().prepare('SELECT 1 FROM onebot_message_recalls WHERE chat_id = ? AND message_id = ?').get(chatId, messageId);
}

/** The shared reader filters both NyatDB and Redis, including copied quote snippets. */
export function filterRecalledOneBotMessages(chatId: number, messages: FormattedMessage[]): FormattedMessage[] {
  if (!isPlatformInternalId(chatId) || messages.length === 0) return messages;
  const ids = [...new Set(messages.flatMap(message => [message.messageId, ...(message.replyTo ? [message.replyTo.messageId] : [])]))];
  const recalled = new Set<number>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const rows = getDb().prepare(`SELECT message_id FROM onebot_message_recalls WHERE chat_id = ? AND message_id IN (${batch.map(() => '?').join(',')})`)
      .all(chatId, ...batch) as Array<{ message_id: number }>;
    for (const row of rows) recalled.add(row.message_id);
  }
  return messages.filter(message => !recalled.has(message.messageId)).map(message => {
    if (!message.replyTo || !recalled.has(message.replyTo.messageId)) return message;
    return { ...message, replyTo: undefined };
  });
}

/** Observed state is for safe suppression and display, never sufficient to grant admin permission. */
export function getOneBotGroupNoticeState(chatId: number): { present: boolean | null; muted: boolean; wholeGroupMuted: boolean } | null {
  if (!isPlatformInternalId(chatId)) return null;
  const ref = findConversationRef(chatId);
  if (!ref || ref.platform !== 'qq' || ref.conversationKind !== 'group') return null;
  const rows = getDb().prepare(`SELECT user_id, present, muted_until FROM onebot_group_member_state
    WHERE account_id = ? AND group_id = ? AND user_id IN (?, '0')`)
    .all(ref.accountId, ref.id, ref.accountId) as Array<{ user_id: string; present: number | null; muted_until: number | null }>;
  const self = rows.find(row => row.user_id === ref.accountId);
  const whole = rows.find(row => row.user_id === '0');
  const muted = (until: number | null | undefined): boolean => until === -1 || (typeof until === 'number' && until > Date.now());
  return { present: self?.present == null ? null : self.present === 1, muted: muted(self?.muted_until), wholeGroupMuted: muted(whole?.muted_until) };
}
