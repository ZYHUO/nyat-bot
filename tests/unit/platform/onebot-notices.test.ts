import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { NormalizedOneBotNotice } from '../../../src/platform/onebot-notices.js';

const mocks = vi.hoisted(() => ({ db: vi.fn(), eval: vi.fn(), lrange: vi.fn(), expire: vi.fn(), nyat: vi.fn(),
  config: { ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '80001', META_ACTIVATED_AT_SEC: 1799999900,
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', NYATDB_ENABLED: false, NYATDB_READ: false,
    NYATDB_DUAL_WRITE: false, NYATDB_REDIS_MIRROR: false, CONTEXT_MAX_LENGTH: 600 } }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.db }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ eval: mocks.eval, lrange: mocks.lrange, expire: mocks.expire }) }));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/nyatdb/index.js', () => ({ getNyatDb: mocks.nyat, chatAppendFromFormatted: vi.fn(),
  unpackChatLogRow: (row: { messageId: number; text: string; uid: number; ts: number }) => ({ role: 'user',
    messageId: row.messageId, textContent: row.text, uid: row.uid, timestamp: row.ts, username: '', fullName: '', isForwarded: false }) }));
import { decodeOneBotNotice, ingestOneBotNotice, filterRecalledOneBotMessages, isOneBotMessageRecalled,
  getOneBotGroupNoticeState } from '../../../src/platform/onebot-notices.js';
import { getOrCreateConversationId, getOrCreateMessageId } from '../../../src/platform/identity-store.js';
import { getRecent } from '../../../src/pipeline/context/manager.js';

const NOW = 1800000000000;
let db: Database.Database;
const group = { platform: 'qq' as const, idNamespace: 'qq-number' as const, accountId: '80001', conversationKind: 'group' as const, id: '50001' };
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', self_id: 80001,
    group_id: 50001, user_id: 60001, operator_id: 70001, time: NOW / 1000, ...overrides };
}
function notice(overrides: Record<string, unknown> = {}): NormalizedOneBotNotice {
  return decodeOneBotNotice(raw(overrides), '80001')!;
}
function message(messageId: number, extra: Partial<FormattedMessage> = {}): FormattedMessage {
  return { messageId, role: 'user', uid: 123, username: '', fullName: 'User', timestamp: NOW / 1000,
    textContent: 'private recalled text', isForwarded: false, ...extra };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  Object.assign(mocks.config, { ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '80001', META_ACTIVATED_AT_SEC: (NOW - 100000) / 1000,
    ONEBOT_ALLOWED_GROUP_IDS: '', ONEBOT_ALLOWED_USER_IDS: '', NYATDB_ENABLED: false, NYATDB_READ: false,
    NYATDB_DUAL_WRITE: false, NYATDB_REDIS_MIRROR: false });
  db = new Database(':memory:');
  for (const file of ['0118_platform_identity.sql', '0120_onebot_notices.sql']) db.exec(readFileSync(`migrations/${file}`, 'utf8'));
  mocks.db.mockReturnValue(db); mocks.eval.mockResolvedValue(1); mocks.lrange.mockResolvedValue([]); mocks.expire.mockResolvedValue(1);
  mocks.nyat.mockReturnValue(null);
});
afterEach(() => { vi.useRealTimers(); if (db.open) db.close(); });

describe('authenticated OneBot lifecycle normalization', () => {
  it.each([
    ['group_increase', 'approve'], ['group_increase', 'invite'], ['group_decrease', 'leave'],
    ['group_decrease', 'kick'], ['group_admin', 'set'], ['group_admin', 'unset'],
    ['group_ban', 'ban'], ['group_ban', 'lift_ban'],
  ])('decodes %s/%s without using the Telegram event surface', (kind, subType) => {
    expect(notice({ notice_type: kind, sub_type: subType, duration: 600 }))
      .toMatchObject({ kind, subType, accountId: '80001', userId: '60001', groupId: '50001', timestampMs: NOW });
  });

  it('handles whole-group ban and signed recall message IDs while rejecting malformed identifiers', () => {
    expect(notice({ notice_type: 'group_ban', sub_type: 'ban', user_id: 0, duration: 0 }).userId).toBe('0');
    expect(notice({ notice_type: 'group_recall', message_id: -321 })).toMatchObject({ messageId: '-321' });
    expect(notice({ notice_type: 'friend_recall', message_id: 321 })).toMatchObject({ kind: 'friend_recall', messageId: '321' });
    expect(notice({ notice_type: 'friend_add' })).toMatchObject({ kind: 'friend_add' });
    expect(decodeOneBotNotice(raw({ notice_type: 'offline_file' }), '80001')).toBeNull();
    for (const bad of [{ self_id: 80002 }, { user_id: Number.MAX_SAFE_INTEGER + 1 },
      { notice_type: 'group_decrease', sub_type: 'kick_me' }, { time: 1.2 },
      { notice_type: 'group_ban', sub_type: 'ban', duration: -1 }, { sub_type: 'unknown' }]) {
      expect(() => notice(bad)).toThrow();
    }
  });

  it('accepts bounded reaction metadata but invents no sentiment or member attribution', async () => {
    const event = notice({ notice_type: 'group_msg_emoji_like', message_id: 321, likes: [{ emoji_id: '76', count: 1 }] });
    expect(event).toMatchObject({ kind: 'group_msg_emoji_like', likes: [{ emojiId: '76', count: 1 }] });
    await ingestOneBotNotice(event);
    expect(db.prepare('SELECT kind FROM onebot_notice_receipts').all()).toEqual([{ kind: 'group_msg_emoji_like' }]);
    expect(mocks.eval).not.toHaveBeenCalled();
    expect(() => notice({ notice_type: 'group_msg_emoji_like', message_id: 321, likes: [{ emoji_id: '76', count: '1' }] })).toThrow();
  });

  it('filters disabled, wrong-account, pre-activation, future, allowlist-denied and aborted notices', async () => {
    mocks.config.ONEBOT_ENABLED = false; await ingestOneBotNotice(notice()); mocks.config.ONEBOT_ENABLED = true;
    await ingestOneBotNotice({ ...notice(), accountId: '80002' });
    await ingestOneBotNotice(notice({ time: (NOW - 101000) / 1000 }));
    await ingestOneBotNotice(notice({ time: (NOW + 301000) / 1000 }));
    await ingestOneBotNotice(notice(), { signal: AbortSignal.abort() });
    mocks.config.ONEBOT_ALLOWED_GROUP_IDS = '50002'; await ingestOneBotNotice(notice());
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_notice_receipts').get()).toEqual({ n: 0 });
    expect(mocks.eval).not.toHaveBeenCalled();
  });
});

describe('durable lifecycle state and member index repair', () => {
  it('updates observed membership without notifications and does not let stale joins undo a departure', async () => {
    const joined = notice();
    await ingestOneBotNotice(joined);
    const left = notice({ notice_type: 'group_decrease', sub_type: 'leave', time: (NOW + 1000) / 1000 });
    await ingestOneBotNotice(left);
    expect(db.prepare('SELECT present, presence_at FROM onebot_group_member_state').get()).toEqual({ present: 0, presence_at: NOW + 1000 });
    expect(mocks.eval).toHaveBeenCalledTimes(2);
    await ingestOneBotNotice(joined);
    expect(mocks.eval).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_notice_receipts').get()).toEqual({ n: 2 });
    const last = mocks.eval.mock.calls.at(-1)!;
    expect(last[1]).toBe(4);
    expect(last[2]).toMatch(/^xxb:members:-450/);
    expect(last[3]).toMatch(/^xxb:user:groups:450/);
    expect(last[8]).toBe('0');
  });

  it('allows duplicate notice to repair a failed Redis update without duplicating durable rows', async () => {
    mocks.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(ingestOneBotNotice(notice())).rejects.toThrow('redis unavailable');
    await ingestOneBotNotice(notice());
    expect(mocks.eval).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_notice_receipts').get()).toEqual({ n: 1 });
  });

  it('gives departures precedence within the same second and passes self-removal to the active-group cleanup', async () => {
    await ingestOneBotNotice(notice({ user_id: 80001 }));
    await ingestOneBotNotice(notice({ notice_type: 'group_decrease', sub_type: 'kick_me', user_id: 80001 }));
    const chatId = getOrCreateConversationId(group);
    expect(getOneBotGroupNoticeState(chatId)).toMatchObject({ present: false });
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.eval.mock.calls[0]!.at(-1)).toBe('1');
    await ingestOneBotNotice(notice({ user_id: 80001 }));
    expect(getOneBotGroupNoticeState(chatId)).toMatchObject({ present: false });
  });

  it('keeps role and mute timestamps independent, without granting authority from cached role', async () => {
    await ingestOneBotNotice(notice({ notice_type: 'group_admin', sub_type: 'set', user_id: 80001 }));
    await ingestOneBotNotice(notice({ notice_type: 'group_ban', sub_type: 'ban', duration: 600, user_id: 80001 }));
    await ingestOneBotNotice(notice({ notice_type: 'group_ban', sub_type: 'ban', duration: 0, user_id: 0 }));
    const chatId = getOrCreateConversationId(group);
    expect(getOneBotGroupNoticeState(chatId)).toEqual({ present: null, muted: true, wholeGroupMuted: true });
    await ingestOneBotNotice(notice({ notice_type: 'group_ban', sub_type: 'lift_ban', duration: 0, user_id: 80001, time: (NOW + 1000) / 1000 }));
    expect(getOneBotGroupNoticeState(chatId)).toMatchObject({ muted: false, wholeGroupMuted: true });
    expect(db.prepare("SELECT role FROM onebot_group_member_state WHERE user_id = '80001'").get()).toEqual({ role: 'admin' });
  });

  it('stores friend-add without activating private chat, sending messages or approving a request', async () => {
    await ingestOneBotNotice(notice({ notice_type: 'friend_add' }));
    expect(db.prepare('SELECT account_id, user_id FROM onebot_friend_state').all()).toEqual([{ account_id: '80001', user_id: '60001' }]);
    expect(mocks.eval).not.toHaveBeenCalled();
  });
});

describe('recall tombstone across storage providers', () => {
  it('removes recalled content and copied quote text, preserving unrelated messages and account scopes', async () => {
    const chatId = getOrCreateConversationId(group);
    const recalled = getOrCreateMessageId({ conversation: group, id: '321' });
    const reply = getOrCreateMessageId({ conversation: group, id: '322' });
    await ingestOneBotNotice(notice({ notice_type: 'group_recall', message_id: 321 }));
    expect(isOneBotMessageRecalled(chatId, recalled)).toBe(true);
    const messages = [message(recalled), message(reply, { textContent: 'new message',
      replyTo: { messageId: recalled, uid: 123, fullName: 'User', textSnippet: 'copied secret' } })];
    const result = filterRecalledOneBotMessages(chatId, messages);
    expect(result).toHaveLength(1);
    expect(result[0]?.replyTo).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(messages[1]?.replyTo?.textSnippet).toBe('copied secret');
    const other = getOrCreateConversationId({ ...group, accountId: '80002' });
    expect(isOneBotMessageRecalled(other, recalled)).toBe(false);
    expect(filterRecalledOneBotMessages(other, messages)).toEqual(messages);
  });

  it('also protects a message that arrives after its recall event', async () => {
    await ingestOneBotNotice(notice({ notice_type: 'group_recall', message_id: 321 }));
    const chatId = getOrCreateConversationId(group);
    const messageId = getOrCreateMessageId({ conversation: group, id: '321' });
    expect(filterRecalledOneBotMessages(chatId, [message(messageId)])).toEqual([]);
    await ingestOneBotNotice(notice({ notice_type: 'group_recall', message_id: 321 }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_message_recalls').get()).toEqual({ n: 1 });
  });

  it('does not open the database for native Telegram messages', () => {
    mocks.db.mockImplementation(() => { throw new Error('database unavailable'); });
    expect(isOneBotMessageRecalled(-100123, 321)).toBe(false);
    const messages = [message(321)];
    expect(filterRecalledOneBotMessages(-100123, messages)).toBe(messages);
  });

  it.each(['redis', 'nyatdb'])('getRecent actually filters recalled data from %s', async provider => {
    const chatId = getOrCreateConversationId(group);
    const messageId = getOrCreateMessageId({ conversation: group, id: '321' });
    await ingestOneBotNotice(notice({ notice_type: 'group_recall', message_id: 321 }));
    if (provider === 'redis') mocks.lrange.mockResolvedValue([JSON.stringify(message(messageId))]);
    else {
      mocks.config.NYATDB_ENABLED = true; mocks.config.NYATDB_READ = true;
      mocks.nyat.mockReturnValue({ chatRecent: () => [{ messageId, uid: 123, ts: NOW / 1000, text: 'private recalled text' }] });
    }
    expect(await getRecent(chatId, 10)).toEqual([]);
  });

  it('fails closed for QQ context if the tombstone database cannot be read', () => {
    const chatId = getOrCreateConversationId(group);
    mocks.db.mockImplementation(() => { throw new Error('database unavailable'); });
    expect(() => filterRecalledOneBotMessages(chatId, [message(2 ** 52 + 123)])).toThrow('database unavailable');
  });
});
